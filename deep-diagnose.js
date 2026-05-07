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

async function deepDiagnose() {
  await c.connect();
  console.log('=== DEEP DIAGNOSIS ===\n');

  // 1. Check if pgcrypto was created in wrong schema
  const ext = await c.query("SELECT extname, nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY extname");
  console.log('Extensions and schemas:');
  ext.rows.forEach(e => console.log(' ', e.extname, '->', e.nspname));

  // 2. Check auth schema migrations
  const authMig = await c.query("SELECT version FROM auth.schema_migrations ORDER BY version DESC LIMIT 5");
  console.log('\nAuth schema migration versions (latest 5):');
  authMig.rows.forEach(m => console.log(' ', m.version));

  // 3. Check auth.flow_state table exists
  const flowState = await c.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'auth' ORDER BY table_name"
  );
  console.log('\nAuth tables:');
  flowState.rows.forEach(t => console.log(' ', t.table_name));

  // 4. Check password hash format
  const pw = await c.query("SELECT encrypted_password FROM auth.users WHERE email = 'admin@sankaj.com'");
  const hash = pw.rows[0].encrypted_password;
  console.log('\nPassword hash prefix:', hash.substring(0, 10));
  console.log('Hash length:', hash.length);
  console.log('Is bcrypt format:', hash.startsWith('$2'));

  // 5. Check confirmed_at and banned status
  const usr = await c.query(`
    SELECT email, email_confirmed_at, banned_until, deleted_at, 
           is_sso_user, confirmation_sent_at, recovery_sent_at
    FROM auth.users WHERE email = 'admin@sankaj.com'
  `);
  console.log('\nUser status:', JSON.stringify(usr.rows[0], null, 2));

  // 6. Check if auth config has hooks
  const hooks = await c.query(`
    SELECT key, value FROM auth.config WHERE key LIKE '%hook%' OR key LIKE '%schema%'
  `).catch(() => ({ rows: [] }));
  if (hooks.rows.length > 0) {
    console.log('\nAuth config hooks:');
    hooks.rows.forEach(h => console.log(' ', h.key, '=', h.value));
  }

  // 7. Check search_path
  const sp = await c.query("SHOW search_path");
  console.log('\nSearch path:', sp.rows[0].search_path);

  // 8. Check for any problematic views using auth functions
  const views = await c.query(`
    SELECT viewname FROM pg_views WHERE schemaname = 'public' AND definition LIKE '%auth.%'
  `);
  console.log('\nPublic views referencing auth:', views.rows.map(v => v.viewname).join(', ') || 'none');

  await c.end();

  // 9. Try direct GoTrue API call for more error details
  console.log('\n=== Direct GoTrue API Test ===');
  const postData = JSON.stringify({ email: 'admin@sankaj.com', password: 'Admin@12345' });
  
  return new Promise((resolve) => {
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
        console.log('Status:', res.statusCode);
        console.log('Response:', data.substring(0, 500));
        resolve();
      });
    });
    req.on('error', e => { console.log('HTTP Error:', e.message); resolve(); });
    req.write(postData);
    req.end();
  });
}

deepDiagnose().catch(e => console.error('Error:', e.message));
