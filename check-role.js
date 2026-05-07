const { Client } = require('pg');

const c = new Client({
  host: 'db.lacasqqbamfbtontddfi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false }
});

async function checkRole() {
  await c.connect();

  // 1. Check supabase_auth_admin role configuration
  console.log('=== supabase_auth_admin Role ===');
  const roleConfig = await c.query(`
    SELECT rolname, rolconfig 
    FROM pg_roles 
    WHERE rolname IN ('supabase_auth_admin', 'authenticator', 'anon', 'service_role', 'supabase_admin')
  `);
  roleConfig.rows.forEach(r => console.log(r.rolname + ':', JSON.stringify(r.rolconfig)));

  // 2. Check search_path for supabase_auth_admin specifically
  console.log('\n=== Search Paths ===');
  const sp = await c.query(`
    SELECT r.rolname, 
           (SELECT string_agg(unnest, ', ') FROM unnest(r.rolconfig)) as config
    FROM pg_roles r 
    WHERE r.rolname = 'supabase_auth_admin'
  `);
  sp.rows.forEach(r => console.log(r.rolname + ':', r.config));

  // 3. Check if there's a "users" table in public schema (conflict!)
  console.log('\n=== Table named "users" in any schema ===');
  const usersTable = await c.query(`
    SELECT table_schema, table_name 
    FROM information_schema.tables 
    WHERE table_name = 'users'
  `);
  usersTable.rows.forEach(r => console.log('  ' + r.table_schema + '.' + r.table_name));

  // 4. Check all schemas
  console.log('\n=== All schemas ===');
  const schemas = await c.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' ORDER BY nspname");
  schemas.rows.forEach(r => console.log('  ' + r.nspname));

  // 5. Check grants for supabase_auth_admin
  console.log('\n=== supabase_auth_admin grants on public schema ===');
  const grants = await c.query(`
    SELECT grantee, privilege_type, table_schema, table_name
    FROM information_schema.table_privileges 
    WHERE grantee = 'supabase_auth_admin' AND table_schema = 'public'
    LIMIT 20
  `);
  grants.rows.forEach(r => console.log('  ' + r.table_schema + '.' + r.table_name + ': ' + r.privilege_type));

  // 6. Try to run the EXACT query GoTrue runs, as supabase_auth_admin
  console.log('\n=== Simulating GoTrue query as supabase_auth_admin ===');
  try {
    await c.query("SET ROLE supabase_auth_admin");
    await c.query("SET search_path TO auth");
    
    const result = await c.query(`
      SELECT users.aud, users.banned_until, users.confirmation_sent_at, 
             users.confirmation_token, users.confirmed_at, users.created_at, 
             users.deleted_at, users.email, users.email_change,
             users.email_change_confirm_status, users.email_change_sent_at, 
             users.email_change_token_current, users.email_change_token_new,
             users.email_confirmed_at, users.encrypted_password, users.id, 
             users.instance_id, users.invited_at, users.is_anonymous,
             users.is_sso_user, users.is_super_admin, users.last_sign_in_at,
             users.phone, users.phone_change, users.phone_change_sent_at,
             users.phone_change_token, users.phone_confirmed_at, 
             users.raw_app_meta_data, users.raw_user_meta_data,
             users.reauthentication_sent_at, users.reauthentication_token,
             users.recovery_sent_at, users.recovery_token, users.role, 
             users.updated_at
      FROM users WHERE users.email = 'admin@sankaj.com' 
      AND users.is_sso_user = false AND users.deleted_at IS NULL
    `);
    console.log('  User found:', result.rows.length > 0 ? 'YES' : 'NO');
    
    // Now try to create a session as supabase_auth_admin
    const crypto = require('crypto');
    const sessId = crypto.randomUUID();
    const refreshToken = crypto.randomBytes(32).toString('hex');
    const userId = result.rows[0]?.id;
    
    if (userId) {
      // Update user
      await c.query("UPDATE users SET last_sign_in_at = now(), updated_at = now() WHERE id = $1", [userId]);
      console.log('  Update last_sign_in_at: OK');
      
      // Update identity
      await c.query("UPDATE identities SET last_sign_in_at = now(), updated_at = now() WHERE user_id = $1 AND provider = 'email'", [userId]);
      console.log('  Update identity: OK');
      
      // Create session
      await c.query(
        "INSERT INTO sessions (id, user_id, created_at, updated_at, aal, not_after, refreshed_at, user_agent, ip) VALUES ($1, $2, now(), now(), 'aal1', NULL, NULL, 'test', '127.0.0.1')",
        [sessId, userId]
      );
      console.log('  Create session: OK');
      
      // Create refresh token
      await c.query(
        "INSERT INTO refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id) VALUES ('00000000-0000-0000-0000-000000000000', $1, $2, false, now(), now(), $3)",
        [refreshToken, userId, sessId]
      );
      console.log('  Create refresh token: OK');
      
      // Create MFA AMR claim
      await c.query(
        "INSERT INTO mfa_amr_claims (id, session_id, created_at, updated_at, authentication_method) VALUES ($1, $2, now(), now(), 'password')",
        [crypto.randomUUID(), sessId]
      );
      console.log('  Create MFA AMR claim: OK');

      // Try to load user factors
      const factors = await c.query("SELECT * FROM mfa_factors WHERE user_id = $1", [userId]);
      console.log('  Load MFA factors: OK, count:', factors.rows.length);

      // Cleanup
      await c.query("DELETE FROM mfa_amr_claims WHERE session_id = $1", [sessId]);
      await c.query("DELETE FROM refresh_tokens WHERE session_id = $1", [sessId]);
      await c.query("DELETE FROM sessions WHERE id = $1", [sessId]);
      console.log('  Cleanup: OK');
    }
    
    await c.query("RESET ROLE");
    console.log('\n  All GoTrue operations succeeded as supabase_auth_admin!');
    
  } catch(e) {
    console.log('  FAILED:', e.message);
    console.log('  Detail:', e.detail || 'none');
    await c.query("RESET ROLE").catch(() => {});
  }

  // 7. Check if there's an auth hook function in the config
  console.log('\n=== Checking for auth hooks in DB config ===');
  try {
    // Some versions store hook config in auth_config or supabase config
    const hookCheck = await c.query(`
      SELECT current_setting('request.jwt.claims', true) as jwt_claims
    `);
    console.log('JWT claims setting:', hookCheck.rows[0]?.jwt_claims || 'none');
  } catch(e) {}

  // Check for any function containing 'hook' or 'custom_access_token'
  const hookFuncs = await c.query(`
    SELECT n.nspname, p.proname 
    FROM pg_proc p 
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname LIKE '%hook%' OR p.proname LIKE '%custom_access%' OR p.proname LIKE '%jwt%'
    ORDER BY n.nspname, p.proname
  `);
  console.log('\nFunctions with hook/jwt/custom_access:');
  if (hookFuncs.rows.length === 0) console.log('  None');
  hookFuncs.rows.forEach(r => console.log('  ' + r.nspname + '.' + r.proname));

  await c.end();
}

checkRole().catch(e => console.error('FATAL:', e.message));
