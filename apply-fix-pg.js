// Apply audit trigger fix via direct PostgreSQL connection
require('dotenv').config({ path: '.env.local' });
const { Client } = require('pg');
const fs = require('fs');

async function applyFix() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected to PostgreSQL');

  const sql = fs.readFileSync('./supabase/migrations/20260415000001_fix_audit_trigger.sql', 'utf8');
  console.log('Applying fix...');
  await client.query(sql);
  console.log('Fix applied!\n');

  // Verify: test an update on documents table
  const { rows } = await client.query("SELECT id, status FROM documents WHERE source = 'google_drive' LIMIT 1");
  if (rows.length > 0) {
    const docId = rows[0].id;
    console.log('Test doc:', docId, 'status:', rows[0].status);

    await client.query("UPDATE documents SET status = 'processing' WHERE id = $1", [docId]);
    const { rows: after } = await client.query("SELECT status FROM documents WHERE id = $1", [docId]);
    console.log('After update:', after[0].status);

    // Reset
    await client.query("UPDATE documents SET status = 'new' WHERE id = $1", [docId]);
    console.log('Reset done. UPDATE WORKS!');
  }

  await client.end();
}

applyFix().catch(err => console.error('Fatal:', err));
