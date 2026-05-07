import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireCapability, normalizeRole } from '@/lib/auth/permissions';

const EDITABLE = new Set(['full_name', 'role', 'is_active', 'email']);

/** PATCH /api/admin/users/[id] — update role / activation / details. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireCapability('admin:manage_users');
  if (auth instanceof Response) return auth;

  // Self-demotion guard: an admin may not strip their own admin role or
  // deactivate themselves (would lock the system out).
  if (auth.userId === params.id) {
    return NextResponse.json(
      { error: 'You cannot modify your own role or status from this endpoint.' },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (EDITABLE.has(k)) patch[k] = k === 'role' ? normalizeRole(v as string) : v;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No editable fields supplied' }, { status: 400 });
  }
  patch.updated_at = new Date().toISOString();

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from('users')
    .update(patch as never)
    .eq('id', params.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ status: 'ok', user: data, by: auth.userId });
}

/** DELETE /api/admin/users/[id] — deactivate (soft-delete) a user. */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireCapability('admin:manage_users');
  if (auth instanceof Response) return auth;

  if (auth.userId === params.id) {
    return NextResponse.json({ error: 'You cannot delete yourself.' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from('users')
    .update({ is_active: false, updated_at: new Date().toISOString() } as never)
    .eq('id', params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ status: 'deactivated', id: params.id, by: auth.userId });
}
