/* eslint-disable */
const { Client } = require('pg');
const fs = require('fs');
require('dotenv').config({ path: '.env.local' });

(async () => {
  const c = new Client({
    connectionString:
      'postgresql://postgres.lacasqqbamfbtontddfi:vR9EN7Q2%3F_%23yLCp@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  const sql = fs.readFileSync(
    'supabase/migrations/20260429000001_add_gdrive_orders_folder_kind.sql',
    'utf8'
  );
  await c.query(sql);
  const r = await c.query(
    "SELECT conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conname='documents_gdrive_folder_kind_check'"
  );
  console.log('Migration applied. Constraint now:', r.rows);
  await c.end();
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
