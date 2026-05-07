const { Client } = require('pg');

const c = new Client({
  host: 'db.lacasqqbamfbtontddfi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false }
});

async function recreate() {
  await c.connect();

  // Clean up any leftover from failed previous run
  const existing = await c.query("SELECT id FROM auth.users WHERE email = 'admin@sankaj.com'");
  if (existing.rows.length > 0) {
    const oldId = existing.rows[0].id;
    await c.query("DELETE FROM user_profiles WHERE id = $1", [oldId]);
    await c.query("DELETE FROM auth.mfa_amr_claims WHERE session_id IN (SELECT id FROM auth.sessions WHERE user_id = $1)", [oldId]);
    await c.query("DELETE FROM auth.refresh_tokens WHERE user_id = $1", [oldId]);
    await c.query("DELETE FROM auth.sessions WHERE user_id = $1", [oldId]);
    await c.query("DELETE FROM auth.identities WHERE user_id = $1", [oldId]);
    await c.query("DELETE FROM auth.users WHERE id = $1", [oldId]);
    console.log('Cleaned up old user:', oldId);
  }

  const newId = require('crypto').randomUUID();
  const now = new Date().toISOString();

  // Create user WITHOUT confirmed_at (it's generated)
  await c.query(`
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at,
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
      $2::timestamptz,
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
  console.log('Auth user created. ID:', newId);

  // Create identity with all fields
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

  // Create profile
  await c.query(
    "INSERT INTO user_profiles (id, full_name, role, email) VALUES ($1, 'Admin User', 'admin', 'admin@sankaj.com')",
    [newId]
  );
  console.log('Profile created.');

  // Verify password
  const pwCheck = await c.query(
    "SELECT encrypted_password = crypt('Admin@12345', encrypted_password) as valid, substring(encrypted_password, 1, 7) as prefix FROM auth.users WHERE id = $1",
    [newId]
  );
  console.log('Password valid:', pwCheck.rows[0].valid, '| Hash:', pwCheck.rows[0].prefix + '...');

  // Verify confirmed_at generated correctly
  const confirmCheck = await c.query(
    "SELECT email_confirmed_at IS NOT NULL as email_confirmed, confirmed_at IS NOT NULL as confirmed FROM auth.users WHERE id = $1",
    [newId]
  );
  console.log('Email confirmed:', confirmCheck.rows[0].email_confirmed, '| Confirmed:', confirmCheck.rows[0].confirmed);

  await c.end();

  // Now test login via GoTrue API
  console.log('\n=== TESTING LOGIN ===');
  const https = require('https');
  const postData = JSON.stringify({ email: 'admin@sankaj.com', password: 'Admin@12345' });
  
  await new Promise((resolve) => {
    const req = https.request({
      hostname: 'lacasqqbamfbtontddfi.supabase.co',
      path: '/auth/v1/token?grant_type=password',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': 'sb_publishable_tKHqArjNrA7b2_NGui1lJg_aM4WFGMZ',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const parsed = JSON.parse(data);
          console.log('LOGIN SUCCESS!');
          console.log('Access token received:', !!parsed.access_token);
          console.log('User email:', parsed.user?.email);
        } else {
          console.log('Status:', res.statusCode);
          console.log('Response:', data.substring(0, 300));
        }
        resolve();
      });
    });
    req.on('error', e => { console.log('HTTP Error:', e.message); resolve(); });
    req.write(postData);
    req.end();
  });
}

recreate().catch(e => console.error('FATAL:', e.message, e.detail || ''));
