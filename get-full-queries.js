const { Client } = require('pg');

const c = new Client({
  host: 'db.lacasqqbamfbtontddfi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false }
});

async function getFullQueries() {
  await c.connect();

  const uid = await c.query("SELECT usesysid FROM pg_user WHERE usename = 'supabase_auth_admin'");
  const authUid = uid.rows[0]?.usesysid;

  // Get FULL query text for non-migration queries (calls > 1 or specific patterns)
  const stmts = await c.query(`
    SELECT query, calls, rows, total_exec_time::int as time_ms
    FROM pg_stat_statements 
    WHERE userid = $1
      AND query NOT LIKE '%CREATE%'
      AND query NOT LIKE '%ALTER%'
      AND query NOT LIKE '%comment%'
      AND query NOT LIKE '%create%index%'
      AND query NOT LIKE '%create%table%'
      AND query NOT LIKE '%DROP%'
      AND query NOT LIKE '%add column%'
      AND query NOT LIKE '%auth_migration%'
      AND query NOT LIKE 'do $$%'
      AND query NOT LIKE 'DO $$%'
    ORDER BY calls DESC
  `, [authUid]);

  stmts.rows.forEach((r, i) => {
    console.log(`\n=== Query ${i+1} (calls=${r.calls}, rows=${r.rows}, time=${r.time_ms}ms) ===`);
    console.log(r.query);
  });

  await c.end();
}

getFullQueries().catch(e => console.error('FATAL:', e.message));
