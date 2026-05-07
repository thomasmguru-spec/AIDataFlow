// Apply the audit trigger fix directly to the live Supabase database
require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function applyFix() {
  const sql = fs.readFileSync('./supabase/migrations/20260415000001_fix_audit_trigger.sql', 'utf8');
  
  console.log('Applying audit trigger fix...');
  console.log('SQL:', sql.substring(0, 200) + '...\n');
  
  // Use the SQL editor via REST API
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  const response = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql })
  });
  
  if (!response.ok) {
    console.log('RPC exec_sql not available, trying direct SQL query endpoint...');
    
    // Try the Supabase SQL endpoint (management API)
    // Extract project ref from URL
    const projectRef = url.replace('https://', '').replace('.supabase.co', '');
    console.log('Project ref:', projectRef);
    
    // Alternative: Use pg directly or supabase CLI
    // Let's try via supabase-js query builder workaround
    
    // Actually, we need to use the Supabase Management API or supabase CLI
    // Let's try supabase db push
    console.log('\nRPC not available. Will try supabase CLI or direct pg connection.');
    console.log('Checking if we have DATABASE_URL or can use supabase CLI...');
    
    if (process.env.DATABASE_URL) {
      console.log('DATABASE_URL found! Using pg to execute SQL...');
      // Use pg module
    } else {
      console.log('No DATABASE_URL. Let me try the Supabase Dashboard SQL API...');
      
      // Try the /pg endpoint
      const pgResponse = await fetch(`${url}/pg`, {
        method: 'POST',
        headers: {
          'apikey': key,
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: sql })
      });
      
      if (pgResponse.ok) {
        console.log('PG endpoint result:', await pgResponse.json());
      } else {
        console.log('PG endpoint response:', pgResponse.status, await pgResponse.text());
        console.log('\n--- MANUAL FIX NEEDED ---');
        console.log('Go to Supabase Dashboard > SQL Editor and run the following SQL:');
        console.log('---');
        console.log(sql);
        console.log('---');
      }
    }
  } else {
    const result = await response.json();
    console.log('Fix applied successfully:', result);
  }
  
  // Test if it works now
  console.log('\n=== Testing update after fix ===');
  const { data: doc } = await supabase
    .from('documents')
    .select('id, status')
    .eq('source', 'google_drive')
    .limit(1)
    .single();
    
  if (doc) {
    const { data, error } = await supabase
      .from('documents')
      .update({ status: 'processing' })
      .eq('id', doc.id)
      .select('id, status');
      
    console.log('Update result:', data);
    console.log('Update error:', error);
    
    if (!error) {
      // Reset
      await supabase
        .from('documents')
        .update({ status: 'new' })
        .eq('id', doc.id);
      console.log('Reset done. FIX IS WORKING!');
    }
  }
}

applyFix().catch(err => console.error('Fatal:', err));
