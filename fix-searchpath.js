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

  // Fix 1: Add extensions to supabase_auth_admin search_path
  console.log('=== Fix: Updating supabase_auth_admin search_path ===');
  await c.query("ALTER ROLE supabase_auth_admin SET search_path TO auth, extensions");
  console.log('search_path updated to: auth, extensions');

  // Fix 2: Also fix authenticator role (the connection role GoTrue uses)
  const authConfig = await c.query("SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'authenticator'");
  console.log('authenticator config:', JSON.stringify(authConfig.rows[0]?.rolconfig));

  // Fix 3: Ensure extensions schema is accessible
  await c.query("GRANT USAGE ON SCHEMA extensions TO supabase_auth_admin");
  console.log('GRANT USAGE on extensions to supabase_auth_admin');

  // Verify the fix
  console.log('\n=== Verifying ===');
  const newConfig = await c.query("SELECT rolconfig FROM pg_roles WHERE rolname = 'supabase_auth_admin'");
  console.log('New supabase_auth_admin config:', JSON.stringify(newConfig.rows[0]?.rolconfig));

  // Reload
  await c.query("NOTIFY pgrst, 'reload schema'");
  console.log('PostgREST schema cache reloaded');

  await c.end();

  // Test login
  console.log('\n=== TESTING LOGIN ===');
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
          console.log('Email:', parsed.user?.email);
          console.log('Access token:', !!parsed.access_token);
        } else {
          console.log('Status:', res.statusCode);
          console.log('Error:', data.substring(0, 300));
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
