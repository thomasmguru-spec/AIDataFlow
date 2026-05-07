const { Client } = require('pg');

const c = new Client({
  host: 'db.lacasqqbamfbtontddfi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false }
});

async function investigate() {
  await c.connect();

  // 1. Check if pgjwt exists and works
  console.log('=== JWT / Vault Check ===');
  try {
    const jwt = await c.query("SELECT * FROM pg_extension WHERE extname = 'pgjwt'");
    console.log('pgjwt extension:', jwt.rows.length > 0 ? 'INSTALLED' : 'NOT INSTALLED');
  } catch(e) { console.log('pgjwt check error:', e.message); }

  // 2. Check vault secrets
  try {
    const secrets = await c.query("SELECT name, description FROM vault.secrets WHERE name LIKE '%jwt%' OR name LIKE '%service%' OR name LIKE '%anon%' ORDER BY name");
    console.log('\nVault secrets:');
    secrets.rows.forEach(s => console.log('  ' + s.name + ': ' + (s.description || '(no desc)')));
  } catch(e) { console.log('Vault check:', e.message.substring(0, 80)); }

  // 3. Try to get service_role key
  try {
    const sr = await c.query("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'");
    if (sr.rows.length > 0) console.log('\nService role key found:', sr.rows[0].decrypted_secret.substring(0, 30) + '...');
  } catch(e) { console.log('Service role key:', e.message.substring(0, 80)); }

  // 4. Check GoTrue JWT secret
  try {
    const jwt = await c.query("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'jwt_secret' OR name LIKE '%jwt%'");
    if (jwt.rows.length > 0) console.log('JWT secret found:', jwt.rows[0].decrypted_secret ? 'YES' : 'NO');
  } catch(e) {}

  // 5. Test UPDATE on auth.users (GoTrue updates last_sign_in_at during login)
  console.log('\n=== Testing UPDATE flow ===');
  const userId = 'b145dad8-4cc5-4d30-8b5d-2f7762197874';
  try {
    await c.query("UPDATE auth.users SET last_sign_in_at = now(), updated_at = now() WHERE id = $1", [userId]);
    console.log('Update auth.users: OK');
  } catch(e) {
    console.log('Update auth.users FAILED:', e.message);
  }

  // 6. Test UPDATE on auth.identities
  try {
    await c.query("UPDATE auth.identities SET last_sign_in_at = now(), updated_at = now() WHERE user_id = $1 AND provider = 'email'", [userId]);
    console.log('Update auth.identities: OK');
  } catch(e) {
    console.log('Update auth.identities FAILED:', e.message);
  }

  // 7. Nuke and recreate user cleanly with higher bcrypt cost
  console.log('\n=== RECREATING USER WITH PROPER BCRYPT ===');
  
  // Delete everything
  await c.query("DELETE FROM user_profiles WHERE id = $1", [userId]);
  await c.query("DELETE FROM auth.identities WHERE user_id = $1", [userId]);
  await c.query("DELETE FROM auth.sessions WHERE user_id = $1", [userId]);
  await c.query("DELETE FROM auth.refresh_tokens WHERE user_id = $1", [userId]);
  await c.query("DELETE FROM auth.users WHERE id = $1", [userId]);
  console.log('Old user deleted completely.');

  // Recreate with proper bcrypt cost (10) and ALL columns populated
  const newId = require('crypto').randomUUID();
  const now = new Date().toISOString();
  
  await c.query(`
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, confirmed_at,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      is_sso_user, is_anonymous,
      confirmation_token, recovery_token,
      email_change_token_new, email_change_token_current,
      phone_change, phone_change_token,
      reauthentication_token,
      email_change_confirm_status
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      $1, 'authenticated', 'authenticated', 'admin@sankaj.com',
      crypt('Admin@12345', gen_salt('bf', 10)),
      $2::timestamptz, $2::timestamptz,
      '{"provider": "email", "providers": ["email"]}'::jsonb,
      '{"full_name": "Admin User"}'::jsonb,
      $2::timestamptz, $2::timestamptz,
      false, false,
      '', '',
      '', '',
      '', '',
      '',
      0
    )
  `, [newId, now]);
  console.log('New auth user created. ID:', newId);

  // Create identity
  await c.query(`
    INSERT INTO auth.identities (
      id, user_id, identity_data, provider, provider_id,
      email, last_sign_in_at, created_at, updated_at
    ) VALUES (
      $1::uuid, $1::uuid,
      jsonb_build_object('sub', $1::text, 'email', 'admin@sankaj.com', 'email_verified', true, 'phone_verified', false),
      'email', $1::text,
      'admin@sankaj.com', $2::timestamptz, $2::timestamptz, $2::timestamptz
    )
  `, [newId, now]);
  console.log('Identity created.');

  // Create user_profiles
  await c.query(`
    INSERT INTO user_profiles (id, full_name, role, email)
    VALUES ($1, 'Admin User', 'admin', 'admin@sankaj.com')
  `, [newId]);
  console.log('User profile created.');

  // Verify
  const check = await c.query("SELECT id, email, encrypted_password FROM auth.users WHERE id = $1", [newId]);
  const hash = check.rows[0].encrypted_password;
  console.log('\nHash prefix:', hash.substring(0, 7), '(cost factor:', hash.split('$')[2] + ')');
  
  const pwValid = await c.query("SELECT encrypted_password = crypt('Admin@12345', encrypted_password) as valid FROM auth.users WHERE id = $1", [newId]);
  console.log('Password valid:', pwValid.rows[0].valid);

  await c.end();
  console.log('\nDone! Try login now.');
}

investigate().catch(e => console.error('FATAL:', e.message, e.detail || ''));
