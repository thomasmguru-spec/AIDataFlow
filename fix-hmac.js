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

  console.log('=== Creating pgcrypto wrapper functions in auth schema ===\n');

  // Create hmac() wrapper in auth schema
  try {
    await c.query(`
      CREATE OR REPLACE FUNCTION auth.hmac(data bytea, key bytea, type text)
      RETURNS bytea AS $$
        SELECT extensions.hmac(data, key, type);
      $$ LANGUAGE sql STABLE;
    `);
    console.log('Created auth.hmac(bytea, bytea, text)');
  } catch(e) { console.log('hmac bytea error:', e.message); }

  try {
    await c.query(`
      CREATE OR REPLACE FUNCTION auth.hmac(data text, key text, type text)
      RETURNS bytea AS $$
        SELECT extensions.hmac(data, key, type);
      $$ LANGUAGE sql STABLE;
    `);
    console.log('Created auth.hmac(text, text, text)');
  } catch(e) { console.log('hmac text error:', e.message); }

  // Create crypt() wrapper
  try {
    await c.query(`
      CREATE OR REPLACE FUNCTION auth.crypt(password text, salt text)
      RETURNS text AS $$
        SELECT extensions.crypt(password, salt);
      $$ LANGUAGE sql STABLE;
    `);
    console.log('Created auth.crypt(text, text)');
  } catch(e) { console.log('crypt error:', e.message); }

  // Create gen_salt() wrapper
  try {
    await c.query(`
      CREATE OR REPLACE FUNCTION auth.gen_salt(type text)
      RETURNS text AS $$
        SELECT extensions.gen_salt(type);
      $$ LANGUAGE sql VOLATILE;
    `);
    console.log('Created auth.gen_salt(text)');
  } catch(e) { console.log('gen_salt error:', e.message); }

  try {
    await c.query(`
      CREATE OR REPLACE FUNCTION auth.gen_salt(type text, iter_count integer)
      RETURNS text AS $$
        SELECT extensions.gen_salt(type, iter_count);
      $$ LANGUAGE sql VOLATILE;
    `);
    console.log('Created auth.gen_salt(text, integer)');
  } catch(e) { console.log('gen_salt(text,int) error:', e.message); }

  // Grant execute to supabase_auth_admin
  try {
    await c.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO supabase_auth_admin");
    console.log('\nGranted function execution to supabase_auth_admin');
  } catch(e) { console.log('Grant error:', e.message); }

  // Verify
  console.log('\n=== Verification ===');
  await c.query("SET search_path TO auth");
  
  try {
    const r = await c.query("SELECT encode(hmac('test', 'key', 'sha256'), 'hex') as result");
    console.log('hmac() from auth path: OK -', r.rows[0].result.substring(0, 20) + '...');
  } catch(e) { console.log('hmac() STILL FAILS:', e.message); }

  try {
    const r = await c.query("SELECT crypt('test', gen_salt('bf')) as result");
    console.log('crypt() from auth path: OK');
  } catch(e) { console.log('crypt() STILL FAILS:', e.message); }

  await c.query("RESET search_path");

  // Reload schema
  await c.query("NOTIFY pgrst, 'reload schema'");
  console.log('\nPostgREST schema reloaded');

  await c.end();

  // Wait a moment then test login
  console.log('\n=== TESTING LOGIN ===');
  
  await new Promise(r => setTimeout(r, 2000));
  
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
          console.log('LOGIN SUCCESS!!!');
          console.log('Email:', parsed.user?.email);
          console.log('Token received:', !!parsed.access_token);
          console.log('Session ID:', parsed.user?.session?.id || 'in token');
        } else {
          console.log('Status:', res.statusCode);
          const parsed = JSON.parse(data);
          console.log('Error:', parsed.msg || parsed.error || data.substring(0, 300));
        }
        resolve();
      });
    });
    req.on('error', e => { console.log('HTTP Error:', e.message); resolve(); });
    req.write(postData);
    req.end();
  });
}

fix().catch(e => console.error('FATAL:', e.message));
