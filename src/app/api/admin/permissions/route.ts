import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  requireCapability,
  ALL_CAPABILITIES,
  CAPABILITY_LABELS,
  invalidatePermissionCache,
  normalizeRole,
} from '@/lib/auth/permissions';

const CANONICAL_ROLES = ['admin', 'manager', 'validator', 'user'] as const;

/**
 * GET /api/admin/permissions
 *
 * Returns the full role -> capability matrix plus the list of all known
 * capabilities (with human-readable labels) so the admin UI can render a
 * checkbox grid.
 */
export async function GET() {
  const auth = await requireCapability('admin:manage_permissions');
  if (auth instanceof Response) return auth;

  const supabase: any = createServiceRoleClient();
  const { data, error } = await supabase
    .from('role_permissions')
    .select('role, capability, allowed');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const matrix: Record<string, Record<string, boolean>> = {};
  for (const role of CANONICAL_ROLES) {
    matrix[role] = {};
    for (const cap of ALL_CAPABILITIES) matrix[role][cap] = false;
  }
  for (const row of data || []) {
    const r = String((row as any).role);
    const c = String((row as any).capability);
    if (!matrix[r]) matrix[r] = {};
    matrix[r][c] = Boolean((row as any).allowed);
  }

  return NextResponse.json({
    roles: CANONICAL_ROLES,
    capabilities: ALL_CAPABILITIES,
    labels: CAPABILITY_LABELS,
    matrix,
  });
}

/**
 * PUT /api/admin/permissions
 * Body: { role: string, capabilities: { [cap]: boolean } }
 *
 * Replaces the full set of capabilities for the given role. Sends a single
 * upsert so the matrix and DB stay in sync.
 */
export async function PUT(req: NextRequest) {
  const auth = await requireCapability('admin:manage_permissions');
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => ({}));
  const role = normalizeRole(body.role);
  const caps = (body.capabilities || {}) as Record<string, boolean>;

  if (!CANONICAL_ROLES.includes(role as any)) {
    return NextResponse.json({ error: `Unknown role '${role}'` }, { status: 400 });
  }

  // Safety: admin must always retain core admin capabilities to avoid lockout.
  if (role === 'admin') {
    caps['admin:manage_users'] = true;
    caps['admin:manage_permissions'] = true;
  }

  const rows = ALL_CAPABILITIES.map(cap => ({
    role,
    capability: cap,
    allowed: Boolean(caps[cap]),
    updated_at: new Date().toISOString(),
  }));

  const supabase: any = createServiceRoleClient();
  const { error } = await supabase
    .from('role_permissions')
    .upsert(rows as never, { onConflict: 'role,capability' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  invalidatePermissionCache();
  return NextResponse.json({ status: 'ok', role, updated: rows.length });
}
