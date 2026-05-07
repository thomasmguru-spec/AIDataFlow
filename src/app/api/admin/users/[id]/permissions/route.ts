import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  requireCapability,
  ALL_CAPABILITIES,
  CAPABILITY_LABELS,
  invalidatePermissionCache,
  normalizeRole,
} from '@/lib/auth/permissions';

/**
 * GET /api/admin/users/[id]/permissions
 *
 * Returns the user's role default for each capability, any per-user override,
 * and the resolved effective permission. Powers the per-user permissions
 * modal in the admin UI.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireCapability('admin:manage_permissions');
  if (auth instanceof Response) return auth;

  const supabase: any = createServiceRoleClient();

  const { data: user, error: uErr } = await supabase
    .from('users')
    .select('id, email, full_name, role')
    .eq('id', params.id)
    .maybeSingle();
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const role = normalizeRole((user as any).role);

  const { data: roleRows } = await supabase
    .from('role_permissions')
    .select('capability, allowed')
    .eq('role', role);
  const roleDefaults: Record<string, boolean> = {};
  for (const r of roleRows || []) {
    roleDefaults[String((r as any).capability)] = Boolean((r as any).allowed);
  }

  const { data: overrideRows } = await supabase
    .from('user_permission_overrides')
    .select('capability, granted')
    .eq('user_id', params.id);
  const overrides: Record<string, boolean> = {};
  for (const r of overrideRows || []) {
    overrides[String((r as any).capability)] = Boolean((r as any).granted);
  }

  const permissions = ALL_CAPABILITIES.map(cap => {
    const def = roleDefaults[cap] ?? false;
    const ov = overrides[cap];
    return {
      capability: cap,
      label: CAPABILITY_LABELS[cap],
      role_default: def,
      override: ov === undefined ? null : ov,
      effective: ov === undefined ? def : ov,
    };
  });

  return NextResponse.json({
    user: { id: (user as any).id, email: (user as any).email, full_name: (user as any).full_name, role },
    permissions,
  });
}

/**
 * PUT /api/admin/users/[id]/permissions
 * Body: { overrides: { [capability]: boolean | null } }
 *
 * For each capability:
 *   - true  => grant override (force enabled regardless of role)
 *   - false => revoke override (force disabled regardless of role)
 *   - null  => clear override (use role default)
 */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireCapability('admin:manage_permissions');
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => ({}));
  const overrides = (body.overrides || {}) as Record<string, boolean | null>;

  const supabase: any = createServiceRoleClient();

  const { data: user } = await supabase
    .from('users')
    .select('id, role')
    .eq('id', params.id)
    .maybeSingle();
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  // Safety: do not allow stripping core admin capabilities from another admin
  // through overrides (would not lock the user out — admin role still grants
  // them — but is misleading). We just refuse those revokes.
  const isAdmin = normalizeRole((user as any).role) === 'admin';

  const upserts: Array<{ user_id: string; capability: string; granted: boolean; updated_at: string; updated_by: string | null }> = [];
  const deletes: string[] = [];

  for (const cap of ALL_CAPABILITIES) {
    if (!(cap in overrides)) continue;
    const v = overrides[cap];
    if (v === null) {
      deletes.push(cap);
    } else {
      if (isAdmin && v === false && (cap === 'admin:manage_users' || cap === 'admin:manage_permissions')) {
        continue; // skip — would be ignored anyway
      }
      upserts.push({
        user_id: params.id,
        capability: cap,
        granted: Boolean(v),
        updated_at: new Date().toISOString(),
        updated_by: auth.userId,
      });
    }
  }

  if (deletes.length > 0) {
    const { error } = await supabase
      .from('user_permission_overrides')
      .delete()
      .eq('user_id', params.id)
      .in('capability', deletes);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (upserts.length > 0) {
    const { error } = await supabase
      .from('user_permission_overrides')
      .upsert(upserts as never, { onConflict: 'user_id,capability' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  invalidatePermissionCache();
  return NextResponse.json({
    status: 'ok',
    upserted: upserts.length,
    deleted: deletes.length,
  });
}
