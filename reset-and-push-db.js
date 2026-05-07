const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://lacasqqbamfbtontddfi.supabase.co';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhY2FzcXFiYW1mYnRvbnRkZGZpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTQ1NTI3NiwiZXhwIjoyMDkxMDMxMjc2fQ.uuiwe2aFRDdQLLJpsMbgSUQ3zLZAJywpNj7X9QuomEE';

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Old tables to clean (in dependency order)
const OLD_TABLES = [
  'silo_export_items', 'silo_exports',
  'exception_comments', 'exceptions',
  'validation_results', 'processing_logs', 'audit_logs',
  'document_ocr_results', 'document_preprocessed',
  'invoice_line_items', 'order_line_items',
  'master_skus', 'master_vendors', 'master_customers',
];

// New tables that should exist after migration
const NEW_TABLES = ['users', 'documents', 'invoices', 'invoice_lines', 'orders', 'order_lines'];

async function main() {
  console.log('=== Step 1: Clean old tables ===');
  
  for (const table of OLD_TABLES) {
    // Check if table exists by attempting to query
    const { error } = await supabase.from(table).select('*').limit(0);
    if (!error) {
      // Table exists. Delete all rows first, then we'll need DDL to drop it
      console.log(`  Deleting all data from: ${table}`);
      // Delete in batches using filter that always matches
      const { error: delErr } = await supabase.from(table).delete().gte('id', '00000000-0000-0000-0000-000000000000');
      if (delErr) {
        // Some tables might not have uuid id, try alternative
        const { error: delErr2 } = await supabase.from(table).delete().neq('id', 'NEVER_MATCH_THIS_STRING_12345');
        if (delErr2) console.log(`    Warning: Could not delete from ${table}: ${delErr2.message}`);
        else console.log(`    Cleared: ${table}`);
      } else {
        console.log(`    Cleared: ${table}`);
      }
    } else {
      console.log(`  Skip (not found): ${table}`);
    }
  }

  // Also clean data from tables that will be recreated
  const SHARED_TABLES = ['invoices', 'orders', 'documents', 'users'];
  for (const table of SHARED_TABLES) {
    const { error } = await supabase.from(table).select('*').limit(0);
    if (!error) {
      console.log(`  Deleting all data from: ${table}`);
      await supabase.from(table).delete().gte('id', '00000000-0000-0000-0000-000000000000');
      console.log(`    Cleared: ${table}`);
    }
  }

  console.log('\n=== Step 2: Cannot DROP/CREATE tables via REST API ===');
  console.log('The Supabase REST API does not support DDL (CREATE/DROP TABLE).');
  console.log('');
  console.log('You MUST run the SQL file in the Supabase SQL Editor:');
  console.log('');
  console.log('1. Open: https://supabase.com/dashboard/project/lacasqqbamfbtontddfi/sql/new');
  console.log('2. Copy the contents of: supabase/reset-and-create.sql');
  console.log('3. Paste into the SQL editor and click "Run"');
  console.log('');
  console.log('The SQL file will:');
  console.log('  - DROP all old tables (master_vendors, exceptions, validation_results, etc.)');
  console.log('  - CREATE 6 new denormalized tables (users, documents, invoices, invoice_lines, orders, order_lines)');
  console.log('  - CREATE views (v_today_stats, v_pending_exceptions)');
  console.log('  - SET UP RLS policies, triggers, and indexes');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
