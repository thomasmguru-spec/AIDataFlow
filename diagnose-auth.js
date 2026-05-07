const { Client } = require('pg');

const c = new Client({
  host: 'db.lacasqqbamfbtontddfi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false }
});

async function diagnose() {
  await c.connect();
  console.log('Connected.\n');

  // 1. Check auth.users
  const user = await c.query(
    "SELECT id, email, encrypted_password IS NOT NULL as has_pw, email_confirmed_at, aud, role, raw_app_meta_data, raw_user_meta_data FROM auth.users WHERE email = 'admin@sankaj.com'"
  );
  console.log('=== AUTH USER ===');
  console.log(JSON.stringify(user.rows[0], null, 2));

  // 2. Check auth.identities
  const identity = await c.query(
    "SELECT * FROM auth.identities WHERE user_id = $1", [user.rows[0].id]
  );
  console.log('\n=== IDENTITY ===');
  console.log('Count:', identity.rows.length);
  if (identity.rows.length > 0) {
    console.log(JSON.stringify(identity.rows[0], null, 2));
  }

  // 3. Check if there's a trigger on auth.users that references public tables
  const triggers = await c.query(
    "SELECT trigger_name, event_manipulation, action_statement FROM information_schema.triggers WHERE event_object_schema = 'auth'"
  );
  console.log('\n=== AUTH TRIGGERS ===');
  triggers.rows.forEach(t => console.log(t.trigger_name, '-', t.event_manipulation, '-', t.action_statement.substring(0, 100)));

  // 4. Check if user_profiles has any trigger that could fail
  const pubTriggers = await c.query(
    "SELECT trigger_name, event_manipulation, action_statement FROM information_schema.triggers WHERE event_object_schema = 'public' AND event_object_table = 'user_profiles'"
  );
  console.log('\n=== USER_PROFILES TRIGGERS ===');
  pubTriggers.rows.forEach(t => console.log(t.trigger_name, '-', t.event_manipulation));

  // 5. Check if there's a handle_new_user function
  const funcs = await c.query(
    "SELECT routine_name, routine_schema FROM information_schema.routines WHERE routine_name LIKE '%user%' AND routine_schema IN ('auth', 'public')"
  );
  console.log('\n=== USER-RELATED FUNCTIONS ===');
  funcs.rows.forEach(f => console.log(f.routine_schema + '.' + f.routine_name));

  // 6. Check RLS on user_profiles  
  const rls = await c.query(
    "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'user_profiles'"
  );
  console.log('\n=== USER_PROFILES RLS ===');
  console.log('RLS enabled:', rls.rows[0].relrowsecurity);
  console.log('RLS forced:', rls.rows[0].relforcerowsecurity);

  // 7. Check policies on user_profiles
  const policies = await c.query(
    "SELECT policyname, permissive, roles, cmd, qual FROM pg_policies WHERE tablename = 'user_profiles'"
  );
  console.log('\n=== USER_PROFILES POLICIES ===');
  policies.rows.forEach(p => console.log(p.policyname, '|', p.cmd, '| roles:', p.roles, '| qual:', (p.qual || '').substring(0, 80)));

  // 8. Try a password verify
  const pwCheck = await c.query(
    "SELECT encrypted_password = crypt('Admin@12345', encrypted_password) as pw_valid FROM auth.users WHERE email = 'admin@sankaj.com'"
  );
  console.log('\n=== PASSWORD CHECK ===');
  console.log('Password valid:', pwCheck.rows[0].pw_valid);

  await c.end();
}

diagnose().catch(e => console.error('Error:', e.message, e.detail || ''));
