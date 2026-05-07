const { Client } = require('pg');

const c = new Client({
  host: 'db.lacasqqbamfbtontddfi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false }
});

async function fix() {
  await c.connect();

  // Get the existing user ID
  const res = await c.query("SELECT id FROM auth.users WHERE email = 'admin@sankaj.com'");
  if (res.rows.length === 0) {
    console.log('No user found!');
    await c.end();
    return;
  }
  const userId = res.rows[0].id;
  console.log('Found user:', userId);

  // Check if identity exists
  const idRes = await c.query("SELECT id FROM auth.identities WHERE user_id = $1", [userId]);
  if (idRes.rows.length > 0) {
    console.log('Identity already exists.');
  } else {
    const now = new Date().toISOString();
    await c.query(`
      INSERT INTO auth.identities (
        id, user_id, identity_data, provider, provider_id,
        last_sign_in_at, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1::uuid, 
        jsonb_build_object('sub', $1::text, 'email', 'admin@sankaj.com', 'email_verified', true),
        'email', $1::text,
        $2::timestamptz, $2::timestamptz, $2::timestamptz
      )
    `, [userId, now]);
    console.log('Identity created!');
  }

  // Check if profile exists
  const profRes = await c.query("SELECT id FROM user_profiles WHERE id = $1", [userId]);
  if (profRes.rows.length > 0) {
    console.log('Profile already exists.');
  } else {
    await c.query(
      "INSERT INTO user_profiles (id, full_name, role, email) VALUES ($1, 'Admin User', 'admin', 'admin@sankaj.com')",
      [userId]
    );
    console.log('Profile created!');
  }

  console.log('\n=== LOGIN CREDENTIALS ===');
  console.log('Email:    admin@sankaj.com');
  console.log('Password: Admin@12345');
  console.log('Role:     admin');
  console.log('=========================');

  await c.end();
}

fix().catch(e => console.error('Error:', e.message, e.detail || ''));
