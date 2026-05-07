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

  const userId = 'b145dad8-4cc5-4d30-8b5d-2f7762197874';

  // Update identity to include email column
  await c.query(
    "UPDATE auth.identities SET email = 'admin@sankaj.com' WHERE user_id = $1",
    [userId]
  );
  console.log('Identity email column updated.');

  // Make sure is_sso_user is set (if column exists)
  try {
    const colCheck = await c.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='auth' AND table_name='users' AND column_name='is_sso_user'"
    );
    if (colCheck.rows.length > 0) {
      await c.query("UPDATE auth.users SET is_sso_user = false WHERE id = $1", [userId]);
      console.log('is_sso_user set to false.');
    }
  } catch (e) {
    console.log('is_sso_user skip:', e.message);
  }

  // Notify PostgREST to reload schema cache
  await c.query("NOTIFY pgrst, 'reload schema'");
  console.log('Schema cache reload notified.');

  // Verify
  const res = await c.query(
    "SELECT i.email as identity_email, i.provider, u.email as user_email FROM auth.identities i JOIN auth.users u ON u.id = i.user_id WHERE i.user_id = $1",
    [userId]
  );
  console.log('Verified:', JSON.stringify(res.rows[0]));

  await c.end();
}

fix().catch(e => console.error('Error:', e.message));
