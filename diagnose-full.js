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
  console.log('=== FULL AUTH.USERS COLUMN CHECK ===\n');

  // 1. Get all columns auth.users should have
  const cols = await c.query(
    "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='auth' AND table_name='users' ORDER BY ordinal_position"
  );
  console.log('auth.users columns:');
  cols.rows.forEach(r => console.log('  ' + r.column_name + ' (' + r.data_type + ') nullable=' + r.is_nullable + ' default=' + (r.column_default || 'none')));

  // 2. Get our user's FULL record
  const user = await c.query("SELECT * FROM auth.users WHERE email = 'admin@sankaj.com'");
  if (user.rows.length === 0) { console.log('No user found!'); await c.end(); return; }
  console.log('\nOur user full record:');
  const u = user.rows[0];
  for (const [k, v] of Object.entries(u)) {
    console.log('  ' + k + ' = ' + JSON.stringify(v));
  }

  // 3. Try to manually do what GoTrue does during login
  console.log('\n=== SIMULATING GOTRUE LOGIN FLOW ===');
  
  // Step a: find user by email
  try {
    const r = await c.query("SELECT id FROM auth.users WHERE email = $1 AND is_sso_user = false AND deleted_at IS NULL", ['admin@sankaj.com']);
    console.log('Step 1 (find user): OK, id=' + r.rows[0]?.id);
  } catch(e) {
    console.log('Step 1 FAILED:', e.message);
  }

  // Step b: create session
  const crypto = require('crypto');
  const sessId = crypto.randomUUID();
  try {
    const r = await c.query(
      "INSERT INTO auth.sessions (id, user_id, created_at, updated_at, factor_id, aal, not_after, refreshed_at, user_agent, ip, tag) VALUES ($1, $2, now(), now(), NULL, 'aal1', NULL, NULL, 'test', '127.0.0.1', NULL) RETURNING id",
      [sessId, u.id]
    );
    console.log('Step 2 (create session): OK, session_id=' + r.rows[0].id);
  } catch(e) {
    console.log('Step 2 (create session) FAILED:', e.message);
    console.log('Detail:', e.detail || 'none');
  }

  // Step c: create refresh token
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const r = await c.query(
      "INSERT INTO auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, parent, session_id) VALUES ('00000000-0000-0000-0000-000000000000', $1, $2, false, now(), now(), NULL, $3) RETURNING id",
      [token, u.id, sessId]
    );
    console.log('Step 3 (create refresh token): OK, id=' + r.rows[0].id);
  } catch(e) {
    console.log('Step 3 (create refresh token) FAILED:', e.message);
    console.log('Detail:', e.detail || 'none');
  }

  // Step d: create mfa_amr_claim
  try {
    const amid = crypto.randomUUID();
    const r = await c.query(
      "INSERT INTO auth.mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) VALUES ($1, $2, now(), now(), 'password') RETURNING id",
      [amid, sessId]
    );
    console.log('Step 4 (create mfa_amr_claim): OK');
  } catch(e) {
    console.log('Step 4 (create mfa_amr_claim) FAILED:', e.message);
    console.log('Detail:', e.detail || 'none');
  }

  // Cleanup
  await c.query("DELETE FROM auth.mfa_amr_claims WHERE session_id = $1", [sessId]);
  await c.query("DELETE FROM auth.refresh_tokens WHERE session_id = $1", [sessId]);
  await c.query("DELETE FROM auth.sessions WHERE id = $1", [sessId]);
  console.log('Cleanup: OK');

  // 4. Check if there are any event triggers or hooks that fire on auth changes
  try {
    const hooks = await c.query("SELECT hook_table_id, hook_name, hook_function_id FROM auth.hooks");
    console.log('\nAuth hooks:', hooks.rows);
  } catch(e) {
    // no hooks table
  }

  // 5. Check supabase_functions.hooks
  try {
    const hooks = await c.query("SELECT * FROM supabase_functions.hooks");
    console.log('\nSupabase function hooks:');
    hooks.rows.forEach(h => console.log('  ', JSON.stringify(h)));
  } catch(e) {
    console.log('\nNo supabase_functions.hooks:', e.message.substring(0, 60));
  }

  // 6. Check for on_auth_user_created trigger
  const trigs = await c.query(`
    SELECT t.tgname, c.relname, n.nspname, pg_get_triggerdef(t.oid) as def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth' AND NOT t.tgisinternal
  `);
  console.log('\nExternal triggers on auth tables:');
  if (trigs.rows.length === 0) console.log('  None');
  trigs.rows.forEach(t => console.log('  ' + t.nspname + '.' + t.relname + '.' + t.tgname));
  trigs.rows.forEach(t => console.log('  DEF:', t.def.substring(0, 200)));

  await c.end();
}

diagnose().catch(e => console.error('FATAL:', e.message));
