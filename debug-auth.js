const { Client } = require('pg');

const c = new Client({
  host: 'db.lacasqqbamfbtontddfi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false }
});

async function debug() {
  await c.connect();

  // Check user
  const userRes = await c.query(
    "SELECT id, email, encrypted_password IS NOT NULL as has_pw, email_confirmed_at IS NOT NULL as confirmed, aud, role FROM auth.users WHERE email = 'admin@sankaj.com'"
  );
  console.log('User:', JSON.stringify(userRes.rows[0], null, 2));

  // Check identity
  const idRes = await c.query(
    "SELECT id, provider, provider_id, identity_data FROM auth.identities WHERE user_id = $1",
    [userRes.rows[0].id]
  );
  console.log('Identity:', JSON.stringify(idRes.rows[0], null, 2));

  // Check identity columns
  const colRes = await c.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'identities' ORDER BY ordinal_position"
  );
  console.log('Identity columns:', colRes.rows.map(r => r.column_name + ':' + r.data_type).join(', '));

  await c.end();
}

debug().catch(e => console.error('Error:', e.message));
