// One-off script to apply the new RBAC permissions migration.
// Usage: node apply-rbac-migration.js
require('dotenv').config({ path: '.env.local' });
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']);

(async () => {
  const file = path.join(__dirname, 'supabase/migrations/20260424000001_rbac_permissions.sql');
  const sql = fs.readFileSync(file, 'utf8');

  const candidates = [
    process.env.DATABASE_URL,
    'postgresql://postgres.lacasqqbamfbtontddfi:vR9EN7Q2%3F_%23yLCp@aws-0-ap-south-1.pooler.supabase.com:5432/postgres',
    'postgresql://postgres.lacasqqbamfbtontddfi:vR9EN7Q2%3F_%23yLCp@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
    'postgresql://postgres.lacasqqbamfbtontddfi:vR9EN7Q2%3F_%23yLCp@aws-0-us-west-1.pooler.supabase.com:5432/postgres',
  ].filter(Boolean);

  for (const cs of candidates) {
    const safe = cs.replace(/:[^:@/]+@/, ':***@');
    process.stdout.write('Trying ' + safe + ' ... ');
    const c = new Client({ connectionString: cs, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
    try {
      await c.connect();
      console.log('connected');
      try {
        await c.query(sql);
        console.log('Migration applied OK');
        const r = await c.query("SELECT COUNT(*) FROM role_permissions");
        console.log('role_permissions rows:', r.rows[0].count);
        const r2 = await c.query("SELECT to_regclass('public.user_permission_overrides') as t");
        console.log('user_permission_overrides:', r2.rows[0].t);
        await c.end();
        process.exit(0);
      } catch (e) {
        console.log('SQL FAIL:', e.message);
        await c.end();
        process.exit(1);
      }
    } catch (e) {
      console.log('connect FAIL:', e.message);
      try { await c.end(); } catch {}
    }
  }
  console.error('All connection attempts failed.');
  process.exit(1);
})();
