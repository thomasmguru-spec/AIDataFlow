const { Client } = require('pg');
const https = require('https');

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
  console.log('=== Creating pgcrypto wrappers in auth schema ===\n');

  // hmac(text, text, text) -> bytea
  await c.query(`
    CREATE OR REPLACE FUNCTION auth.hmac(data text, key text, type text)
    RETURNS bytea AS $$
      SELECT extensions.hmac(data, key, type);
    $$ LANGUAGE sql STABLE;
  `);
  console.log('Created auth.hmac(text, text, text)');

  // hmac(bytea, bytea, text) -> bytea
  await c.query(`
    CREATE OR REPLACE FUNCTION auth.hmac(data bytea, key bytea, type text)
    RETURNS bytea AS $$
      SELECT extensions.hmac(data, key, type);
    $$ LANGUAGE sql STABLE;
  `);
  console.log('Created auth.hmac(bytea, bytea, text)');

  // crypt(text, text) -> text
  await c.query(`
    CREATE OR REPLACE FUNCTION auth.crypt(password text, salt text)
    RETURNS text AS $$
      SELECT extensions.crypt(password, salt);
    $$ LANGUAGE sql STABLE;
  `);
  console.log('Created auth.crypt(text, text)');

  // gen_salt(text) -> text
  await c.query(`
    CREATE OR REPLACE FUNCTION auth.gen_salt(type text)
    RETURNS text AS $$
      SELECT extensions.gen_salt(type);
    $$ LANGUAGE sql VOLATILE;
  `);
  console.log('Created auth.gen_salt(text)');

  // gen_salt(text, int) -> text
  await c.query(`
    CREATE OR REPLACE FUNCTION auth.gen_salt(type text, iter_count integer)
    RETURNS text AS $$
      SELECT extensions.gen_salt(type, iter_count);
    $$ LANGUAGE sql VOLATILE;
  `);
  console.log('Created auth.gen_salt(text, integer)');

  // Grant execute to supabase_auth_admin
  await c.query("GRANT EXECUTE ON FUNCTION auth.hmac(text, text, text) TO supabase_auth_admin");
  await c.query("GRANT EXECUTE ON FUNCTION auth.hmac(bytea, bytea, text) TO supabase_auth_admin");
  await c.query("GRANT EXECUTE ON FUNCTION auth.crypt(text, text) TO supabase_auth_admin");
  await c.query("GRANT EXECUTE ON FUNCTION auth.gen_salt(text) TO supabase_auth_admin");
  await c.query("GRANT EXECUTE ON FUNCTION auth.gen_salt(text, integer) TO supabase_auth_admin");
  console.log('Granted EXECUTE to supabase_auth_admin');

  // Verify from auth search_path
  console.log('\n=== Verification ===');
  await c.query("SET search_path TO auth");
  
  const hmacTest = await c.query("SELECT encode(hmac('test', 'key', 'sha256'), 'hex') as result");
  console.log('hmac(): OK -', hmacTest.rows[0].result.substring(0, 20) + '...');

  const cryptTest = await c.query("SELECT crypt('test', gen_salt('bf')) as result");
  console.log('crypt()+gen_salt(): OK -', cryptTest.rows[0].result.substring(0, 10) + '...');

  await c.query("RESET search_path");
  await c.query("NOTIFY pgrst, 'reload schema'");
  console.log('Schema reloaded\n');
  await c.end();

  // Test login
  console.log('=== TESTING LOGIN ===');
  await new Promise(r => setTimeout(r, 1500));

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
          console.log('\n*** LOGIN SUCCESS! ***');
          console.log('Email:', parsed.user?.email);
          console.log('Access token:', parsed.access_token?.substring(0, 30) + '...');
          console.log('Refresh token:', !!parsed.refresh_token);
          console.log('\nCredentials:');
          console.log('  Email:    admin@sankaj.com');
          console.log('  Password: Admin@12345');
        } else {
          console.log('Status:', res.statusCode);
          try { console.log('Error:', JSON.parse(data).msg); } catch { console.log(data.substring(0, 300)); }
        }
        resolve();
      });
    });
    req.on('error', e => { console.log('HTTP Error:', e.message); resolve(); });
    req.write(postData);
    req.end();
  });
}

fix().catch(e => console.error('FATAL:', e.message, e.detail || ''));
