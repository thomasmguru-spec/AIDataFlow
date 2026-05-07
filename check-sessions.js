const { Client } = require('pg');

const c = new Client({
  host: 'db.lacasqqbamfbtontddfi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  await c.connect();

  // 1. Check ALL columns of auth.sessions
  console.log('=== auth.sessions columns ===');
  const sessCol = await c.query(
    "SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema='auth' AND table_name='sessions' ORDER BY ordinal_position"
  );
  sessCol.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type}) nullable=${r.is_nullable} default=${r.column_default || 'none'}`));

  // 2. Check ALL columns of auth.refresh_tokens
  console.log('\n=== auth.refresh_tokens columns ===');
  const rtCol = await c.query(
    "SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema='auth' AND table_name='refresh_tokens' ORDER BY ordinal_position"
  );
  rtCol.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type}) nullable=${r.is_nullable} default=${r.column_default || 'none'}`));

  // 3. Check auth.mfa_amr_claims columns
  console.log('\n=== auth.mfa_amr_claims columns ===');
  const amrCol = await c.query(
    "SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema='auth' AND table_name='mfa_amr_claims' ORDER BY ordinal_position"
  );
  amrCol.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type}) nullable=${r.is_nullable} default=${r.column_default || 'none'}`));

  // 4. Check one_time_tokens
  console.log('\n=== auth.one_time_tokens columns ===');
  const ottCol = await c.query(
    "SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema='auth' AND table_name='one_time_tokens' ORDER BY ordinal_position"
  );
  ottCol.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type}) nullable=${r.is_nullable} default=${r.column_default || 'none'}`));

  // 5. Check webauthn tables
  console.log('\n=== auth.webauthn_credentials columns ===');
  const webCol = await c.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='auth' AND table_name='webauthn_credentials' ORDER BY ordinal_position"
  );
  webCol.rows.forEach(r => console.log(`  ${r.column_name} (${r.data_type})`));

  // 6. Check if GoTrue accesses any function that might fail
  // Specifically check if there's a "encrypt" or signing function GoTrue needs
  console.log('\n=== Checking for missing dependencies ===');
  
  // Test: can supabase_auth_admin call gen_random_uuid?
  try {
    await c.query("SET search_path TO auth");
    const uuid = await c.query("SELECT gen_random_uuid()");
    console.log('gen_random_uuid() from auth path: OK');
  } catch(e) {
    console.log('gen_random_uuid() FAILED:', e.message);
  }

  // Test: can we access pg_catalog functions?
  try {
    const ts = await c.query("SELECT now()");
    console.log('now() from auth path: OK');
  } catch(e) {
    console.log('now() FAILED:', e.message);
  }

  // Test: hmac function (needed for refresh_token_hmac_key)
  try {
    const hmac = await c.query("SELECT encode(hmac('data', 'key', 'sha256'), 'hex')");
    console.log('hmac() from auth path: OK');
  } catch(e) {
    console.log('hmac() FAILED from auth path:', e.message);
  }

  // Test: encode/decode
  try {
    const enc = await c.query("SELECT encode('test'::bytea, 'hex')");
    console.log('encode() from auth path: OK');
  } catch(e) {
    console.log('encode() FAILED:', e.message);
  }

  await c.query("RESET search_path");

  // 7. Check CONSTRAINTS on auth tables that might cause issues
  console.log('\n=== Constraints on auth.sessions ===');
  const constraints = await c.query(`
    SELECT conname, contype, pg_get_constraintdef(c.oid) as def
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'auth' AND conrelid = 'auth.sessions'::regclass
  `);
  constraints.rows.forEach(r => console.log(`  ${r.conname} (${r.contype}): ${r.def}`));

  await c.end();
}

check().catch(e => console.error('FATAL:', e.message));
