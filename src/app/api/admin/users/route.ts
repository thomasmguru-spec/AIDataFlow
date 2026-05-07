import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { requireCapability, normalizeRole } from '@/lib/auth/permissions';

/** GET /api/admin/users — list all users (admin only). */
export async function GET() {
  const auth = await requireCapability('admin:manage_users');
  if (auth instanceof Response) return auth;

  const supabase = createServiceRoleClient();

  const { data: users, error } = await supabase
    .from('users')
    .select('id, auth_user_id, email, full_name, role, is_active, preferences, created_at, updated_at')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Optionally enrich with last_sign_in from auth.users
  const enriched: any[] = [];
  for (const u of users || []) {
    let lastSignIn: string | null = null;
    if (u.auth_user_id) {
      const { data: authUser } = await supabase.auth.admin.getUserById(u.auth_user_id);
      lastSignIn = authUser?.user?.last_sign_in_at ?? null;
    }
    enriched.push({
      ...u,
      role: normalizeRole(u.role),
      last_sign_in_at: lastSignIn,
    });
  }

  return NextResponse.json({ data: enriched, total: enriched.length });
}

/**
 * POST /api/admin/users — create a new user.
 * Body: { email, full_name, role, password, is_active? }
 *
 * Creates the auth.users row via supabase.auth.admin.createUser, then
 * inserts the matching public.users profile row.
 */
export async function POST(req: NextRequest) {
  const auth = await requireCapability('admin:manage_users');
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => ({}));
  const email = String(body.email || '').trim();
  const fullName = String(body.full_name || '').trim();
  const role = normalizeRole(body.role);
  const password = String(body.password || '');
  const isActive = body.is_active !== false;

  if (!email || !fullName || !password) {
    return NextResponse.json(
      { error: 'email, full_name, and password are required' },
      { status: 400 }
    );
  }

  const supabase = createServiceRoleClient();

  const { data: created, error: authErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (authErr || !created.user) {
    return NextResponse.json({ error: authErr?.message || 'Failed to create auth user' }, { status: 500 });
  }

  const { data: profile, error: profErr } = await supabase
    .from('users')
    .insert({
      auth_user_id: created.user.id,
      email,
      full_name: fullName,
      role,
      is_active: isActive,
    } as never)
    .select()
    .single();

  if (profErr) {
    // Rollback: delete the auth user we just created
    await supabase.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: profErr.message }, { status: 500 });
  }

  return NextResponse.json({ status: 'created', user: profile });
}
