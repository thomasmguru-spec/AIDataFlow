const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const c = new Client({
  host: 'db.lacasqqbamfbtontddfi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  await c.connect();
  console.log('Connected to Supabase PostgreSQL.');

  // Migration 1: Initial Schema
  console.log('\n--- Running Migration 1: Initial Schema ---');
  const sql1 = fs.readFileSync(
    path.join(__dirname, 'supabase/migrations/20260406000001_initial_schema.sql'),
    'utf8'
  );
  await c.query(sql1);
  console.log('Migration 1: SUCCESS');

  // Verify tables created
  const tables = await c.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  );
  console.log('Tables created:', tables.rows.map(r => r.table_name).join(', '));

  // Migration 2: RLS Policies
  console.log('\n--- Running Migration 2: RLS Policies ---');
  const sql2 = fs.readFileSync(
    path.join(__dirname, 'supabase/migrations/20260406000002_rls_policies.sql'),
    'utf8'
  );
  await c.query(sql2);
  console.log('Migration 2: SUCCESS');

  // Migration 3: Functions & Views
  console.log('\n--- Running Migration 3: Functions & Views ---');
  const sql3 = fs.readFileSync(
    path.join(__dirname, 'supabase/migrations/20260406000003_functions_views.sql'),
    'utf8'
  );
  await c.query(sql3);
  console.log('Migration 3: SUCCESS');

  // Seed Data
  console.log('\n--- Running Seed Data ---');
  const seedSql = fs.readFileSync(
    path.join(__dirname, 'supabase/seed.sql'),
    'utf8'
  );
  await c.query(seedSql);
  console.log('Seed Data: SUCCESS');

  // Final verification
  console.log('\n--- Final Verification ---');
  const finalTables = await c.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  );
  console.log('All tables:', finalTables.rows.map(r => r.table_name).join(', '));

  const skuCount = await c.query('SELECT COUNT(*) FROM master_skus');
  const custCount = await c.query('SELECT COUNT(*) FROM master_customers');
  const vendCount = await c.query('SELECT COUNT(*) FROM master_vendors');
  console.log('Seed counts - SKUs:', skuCount.rows[0].count, '| Customers:', custCount.rows[0].count, '| Vendors:', vendCount.rows[0].count);

  await c.end();
  console.log('\nAll migrations and seed data applied successfully!');
}

run().catch(async (e) => {
  console.error('MIGRATION FAILED:', e.message);
  console.error('Detail:', e.detail || 'none');
  await c.end().catch(() => {});
  process.exit(1);
});
