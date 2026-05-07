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

async function captureQueries() {
  await c.connect();

  // Enable statement logging temporarily
  await c.query("SET log_statement = 'all'");

  // Check current pg_stat_activity for supabase_auth_admin queries
  console.log('=== Current auth admin activity ===');
  const before = await c.query(`
    SELECT pid, state, query, wait_event_type, wait_event
    FROM pg_stat_activity 
    WHERE usename = 'supabase_auth_admin' 
    ORDER BY query_start DESC
    LIMIT 5
  `);
  before.rows.forEach(r => console.log('  PID:', r.pid, '| State:', r.state, '| Query:', (r.query || '').substring(0, 150)));

  // Now trigger login and capture queries
  console.log('\n=== Triggering login... ===');
  
  // Start polling pg_stat_activity
  const interval = setInterval(async () => {
    try {
      const activity = await c.query(`
        SELECT pid, state, query, query_start, wait_event_type
        FROM pg_stat_activity 
        WHERE usename = 'supabase_auth_admin' AND state = 'active' AND query NOT LIKE '%pg_stat_activity%'
        ORDER BY query_start DESC
      `);
      if (activity.rows.length > 0) {
        activity.rows.forEach(r => console.log('  CAPTURED:', r.query?.substring(0, 300)));
      }
    } catch(e) {}
  }, 50);

  // Make login request
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
        console.log('\nLogin response:', res.statusCode, data.substring(0, 200));
        resolve();
      });
    });
    req.write(postData);
    req.end();
  });

  clearInterval(interval);

  // Check for recent errors
  console.log('\n=== Recent auth admin queries ===');
  const after = await c.query(`
    SELECT pid, state, query, query_start
    FROM pg_stat_activity 
    WHERE usename = 'supabase_auth_admin'
    ORDER BY query_start DESC
    LIMIT 10
  `);
  after.rows.forEach(r => console.log('  [' + r.state + '] ' + (r.query || '').substring(0, 200)));

  // Also check for any failed statements in pg_stat_statements
  try {
    const failedStmts = await c.query(`
      SELECT query, calls, total_exec_time, rows
      FROM pg_stat_statements 
      WHERE userid = (SELECT usesysid FROM pg_user WHERE usename = 'supabase_auth_admin')
      ORDER BY total_exec_time DESC
      LIMIT 15
    `);
    console.log('\n=== Top auth admin statements ===');
    failedStmts.rows.forEach(r => console.log('  calls=' + r.calls + ' time=' + Math.round(r.total_exec_time) + 'ms rows=' + r.rows + ' | ' + r.query.substring(0, 200)));
  } catch(e) {
    console.log('pg_stat_statements:', e.message.substring(0, 80));
  }

  await c.end();
}

captureQueries().catch(e => console.error('FATAL:', e.message));
