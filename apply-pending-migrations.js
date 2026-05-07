// Apply pending migrations idempotently to the Supabase Postgres DB.
// Reads every .sql file under supabase/migrations and executes it.
// Each migration uses IF NOT EXISTS / OR REPLACE so it is safe to re-run.

const { Client } = require('pg');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

const ONLY = process.argv[2] || null; // optional filename substring to filter

// Supabase has retired direct `db.<ref>.supabase.co` hostnames; use the
// session-mode pooler instead. Username format is `postgres.<project_ref>`.
const c = new Client({
  host: 'aws-0-ap-south-1.pooler.supabase.com',
  port: 5432, // 5432 = session mode (allows DDL); 6543 = transaction mode
  database: 'postgres',
  user: 'postgres.lacasqqbamfbtontddfi',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false },
});

(async () => {
  await c.connect();
  console.log('Connected to Supabase Postgres.');

  const dir = path.join(__dirname, 'supabase/migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const f of files) {
    if (ONLY && !f.includes(ONLY)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    process.stdout.write(`\n>> ${f} ... `);
    try {
      await c.query(sql);
      console.log('OK');
    } catch (e) {
      console.log('FAIL:', e.message);
      // Continue with next migration so a partial state still makes progress.
    }
  }

  // Verify the new columns exist
  const verify = await c.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('orders', 'invoices')
      AND column_name IN ('approval_status','reviewed_by','approved_by','rejection_reason','total_amount')
    ORDER BY table_name, column_name;
  `);
  console.log('\nVerification:');
  for (const r of verify.rows) console.log(`  ${r.table_name}.${r.column_name}`);

  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
