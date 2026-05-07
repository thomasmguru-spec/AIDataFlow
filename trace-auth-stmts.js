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

async function trace() {
  await c.connect();

  // Get supabase_auth_admin userid
  const uid = await c.query("SELECT usesysid FROM pg_user WHERE usename = 'supabase_auth_admin'");
  const authUid = uid.rows[0]?.usesysid;
  console.log('supabase_auth_admin usesysid:', authUid);

  // Get ALL statements from supabase_auth_admin, ordered by most recent
  console.log('\n=== ALL pg_stat_statements for supabase_auth_admin ===\n');
  const stmts = await c.query(`
    SELECT query, calls, total_exec_time::int as time_ms, rows, 
           mean_exec_time::int as avg_ms
    FROM pg_stat_statements 
    WHERE userid = $1
    ORDER BY calls DESC
  `, [authUid]);
  
  stmts.rows.forEach((r, i) => {
    const q = r.query.replace(/\s+/g, ' ').substring(0, 200);
    console.log(`[${i+1}] calls=${r.calls} rows=${r.rows} time=${r.time_ms}ms avg=${r.avg_ms}ms`);
    console.log(`    ${q}`);
    console.log();
  });

  // Also check for errors in recent pg_stat_activity
  console.log('\n=== Current supabase_auth_admin connections ===');
  const conns = await c.query(`
    SELECT pid, state, wait_event_type, wait_event, backend_type,
           query_start, state_change, query
    FROM pg_stat_activity 
    WHERE usename = 'supabase_auth_admin'
  `);
  conns.rows.forEach(r => {
    console.log(`PID ${r.pid}: ${r.state} | wait: ${r.wait_event_type}/${r.wait_event}`);
    console.log(`  Query: ${(r.query || '').replace(/\s+/g, ' ').substring(0, 200)}`);
  });

  await c.end();
}

trace().catch(e => console.error('FATAL:', e.message));
