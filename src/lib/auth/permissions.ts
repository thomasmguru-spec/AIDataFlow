import { createServerSupabase, createServiceRoleClient } from '@/lib/supabase/server';
import type { UserRole } from '@/types';

/** Normalize legacy role names to the canonical set. */
export function normalizeRole(role: string | null | undefined): UserRole {
  switch ((role || '').toLowerCase()) {
    case 'admin':
      return 'admin';
    case 'manager':
      return 'manager';
    case 'reviewer':
    case 'validator':
      return 'validator';
    case 'read_only':
    case 'user':
    case '':
      return 'user';
    default:
      return 'user';
  }
}

export type Capability =
  | 'orders:view'
  | 'orders:edit'
  | 'orders:delete'
  | 'orders:review'    // mark order as reviewed (validator)
  | 'orders:approve'   // approve / reject order (manager+)
  | 'invoices:view'
  | 'invoices:edit'
  | 'invoices:delete'
  | 'invoices:review'   // mark as reviewed (validator)
  | 'invoices:approve'  // approve / reject (manager+)
  | 'admin:manage_users'
  | 'admin:manage_permissions';

/** All known capabilities (used by admin UI to render the matrix). */
export const ALL_CAPABILITIES: Capability[] = [
  'orders:view', 'orders:edit', 'orders:delete', 'orders:review', 'orders:approve',
  'invoices:view', 'invoices:edit', 'invoices:delete', 'invoices:review', 'invoices:approve',
  'admin:manage_users', 'admin:manage_permissions',
];

/** Human-readable description for each capability (admin UI). */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  'orders:view':              'View orders',
  'orders:edit':              'Edit orders',
  'orders:delete':            'Delete orders',
  'orders:review':            'Mark orders reviewed',
  'orders:approve':           'Approve / reject orders',
  'invoices:view':            'View invoices',
  'invoices:edit':            'Edit invoices',
  'invoices:delete':          'Delete invoices',
  'invoices:review':          'Mark invoices reviewed',
  'invoices:approve':         'Approve / reject invoices',
  'admin:manage_users':       'Manage users (create / deactivate / change role)',
  'admin:manage_permissions': 'Manage role + per-user permissions',
};

/** Static fallback matrix — used only if the DB matrix is unavailable. */
const FALLBACK_MATRIX: Record<UserRole, Capability[]> = {
  admin: [
    'orders:view', 'orders:edit', 'orders:delete', 'orders:review', 'orders:approve',
    'invoices:view', 'invoices:edit', 'invoices:delete',
    'invoices:review', 'invoices:approve',
    'admin:manage_users', 'admin:manage_permissions',
  ],
  manager: [
    'orders:view', 'orders:edit', 'orders:review', 'orders:approve',
    'invoices:view', 'invoices:edit',
    'invoices:review', 'invoices:approve',
  ],
  validator: [
    'orders:view', 'orders:edit', 'orders:review',
    'invoices:view', 'invoices:edit', 'invoices:review',
  ],
  user: [
    'orders:view', 'invoices:view',
  ],
  // legacy aliases (resolved via normalizeRole, kept for completeness)
  reviewer: [
    'orders:view', 'orders:edit', 'orders:review',
    'invoices:view', 'invoices:edit', 'invoices:review',
  ],
  read_only: [
    'orders:view', 'invoices:view',
  ],
};

export function can(role: string | null | undefined, capability: Capability): boolean {
  const r = normalizeRole(role);
  return FALLBACK_MATRIX[r].includes(capability);
}

// ---------------------------------------------------------------------------
// DB-backed permission resolution (admin-editable matrix + per-user overrides)
// ---------------------------------------------------------------------------

interface PermissionCache {
  roleMatrix: Record<string, Set<string>>;
  userOverrides: Map<string, Map<string, boolean>>;
  loadedAt: number;
}

const CACHE_TTL_MS = 15_000; // 15s — short enough that admin edits propagate quickly
let _cache: PermissionCache | null = null;
let _loading: Promise<PermissionCache> | null = null;

/** Force a reload of the permission cache on next read. */
export function invalidatePermissionCache() {
  _cache = null;
  _loading = null;
}

async function loadPermissionCache(): Promise<PermissionCache> {
  if (_cache && Date.now() - _cache.loadedAt < CACHE_TTL_MS) return _cache;
  if (_loading) return _loading;

  _loading = (async () => {
    const supabase = createServiceRoleClient();
    const roleMatrix: Record<string, Set<string>> = {};
    const userOverrides: Map<string, Map<string, boolean>> = new Map();

    try {
      const sb: any = supabase;
      const { data: roleRows } = await sb
        .from('role_permissions')
        .select('role, capability, allowed');
      for (const r of roleRows || []) {
        if (!(r as any).allowed) continue;
        const role = String((r as any).role);
        const cap = String((r as any).capability);
        if (!roleMatrix[role]) roleMatrix[role] = new Set();
        roleMatrix[role].add(cap);
      }

      const { data: overrideRows } = await sb
        .from('user_permission_overrides')
        .select('user_id, capability, granted');
      for (const r of overrideRows || []) {
        const uid = String((r as any).user_id);
        const cap = String((r as any).capability);
        let m = userOverrides.get(uid);
        if (!m) { m = new Map(); userOverrides.set(uid, m); }
        m.set(cap, Boolean((r as any).granted));
      }
    } catch {
      // Best effort — fall back to static matrix below.
    }

    const cache: PermissionCache = { roleMatrix, userOverrides, loadedAt: Date.now() };
    _cache = cache;
    _loading = null;
    return cache;
  })();

  return _loading;
}

/** Resolve effective permission given role + optional userId (DB-backed). */
export async function canAsync(
  role: string | null | undefined,
  capability: Capability,
  userId?: string | null
): Promise<boolean> {
  const r = normalizeRole(role);
  const cache = await loadPermissionCache();

  // Per-user override always wins
  if (userId) {
    const override = cache.userOverrides.get(userId)?.get(capability);
    if (override !== undefined) return override;
  }

  // Role from DB matrix
  const roleSet = cache.roleMatrix[r];
  if (roleSet) return roleSet.has(capability);

  // Legacy alias fallback
  if (r === 'reviewer' && cache.roleMatrix['validator']) return cache.roleMatrix['validator'].has(capability);
  if (r === 'read_only' && cache.roleMatrix['user']) return cache.roleMatrix['user'].has(capability);

  // Final fallback to static matrix
  return FALLBACK_MATRIX[r].includes(capability);
}

export interface AuthContext {
  authUserId: string;
  userId: string | null;
  email: string | null;
  role: UserRole;
  fullName: string | null;
}

/**
 * Resolve the current request's auth user + DB user row + canonical role.
 * Returns null when the user is unauthenticated or has no profile row.
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  const supabase = createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from('users')
    .select('id, email, full_name, role')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  return {
    authUserId: user.id,
    userId: profile?.id ?? null,
    email: profile?.email ?? user.email ?? null,
    role: normalizeRole(profile?.role),
    fullName: profile?.full_name ?? null,
  };
}

/**
 * Guard an API route. Returns either a JSON 401/403 Response (caller should
 * return it directly) or the resolved AuthContext.
 */
export async function requireCapability(capability: Capability): Promise<AuthContext | Response> {
  const ctx = await getAuthContext();
  if (!ctx) {
    return new Response(JSON.stringify({ error: 'Unauthenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!(await canAsync(ctx.role, capability, ctx.userId))) {
    return new Response(
      JSON.stringify({ error: 'Forbidden', required: capability, role: ctx.role }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return ctx;
}
