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

  // 1. Check auth.jwt function
  console.log('=== auth.jwt function ===');
  try {
    const def = await c.query("SELECT pg_get_functiondef(oid) as def FROM pg_proc WHERE proname = 'jwt' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'auth')");
    if (def.rows.length > 0) console.log(def.rows[0].def);
    else console.log('Function not found');
  } catch(e) { console.log('Error:', e.message); }

  // 2. Check ALL functions in auth schema
  console.log('\n=== All functions in auth schema ===');
  const funcs = await c.query(`
    SELECT p.proname, pg_get_function_arguments(p.oid) as args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth'
    ORDER BY p.proname
  `);
  funcs.rows.forEach(r => console.log('  auth.' + r.proname + '(' + r.args + ')'));

  // 3. Check if there are any RLS policies referencing our custom function on auth tables
  console.log('\n=== RLS policies on auth tables ===');
  const authPolicies = await c.query(`
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'auth'
  `);
  if (authPolicies.rows.length === 0) console.log('  None (as expected)');
  authPolicies.rows.forEach(r => console.log('  ' + r.tablename + ': ' + r.policyname));

  // 4. Check auth schema migrations and see if there's a mismatch
  console.log('\n=== Auth schema migrations ===');
  const migs = await c.query("SELECT version FROM auth.schema_migrations ORDER BY version");
  console.log('Total migrations:', migs.rows.length);
  console.log('Latest:', migs.rows[migs.rows.length - 1]?.version);
  
  // 5. Check if GoTrue has ONE_TIME_TOKENS reference
  console.log('\n=== one_time_tokens table ===');
  const ott = await c.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='auth' AND table_name='one_time_tokens' ORDER BY ordinal_position"
  );
  console.log('Columns:', ott.rows.map(r => r.column_name).join(', '));

  // 6. The real test: Check if there's a "custom_access_token" hook configured
  console.log('\n=== Checking config table for hooks ===');
  // Try auth.config (some versions)
  try {
    const cfg = await c.query("SELECT * FROM auth.config LIMIT 5");
    console.log('auth.config:', JSON.stringify(cfg.rows));
  } catch(e) {
    console.log('No auth.config table');
  }

  // Try auth.hooks
  try {
    const hooks = await c.query("SELECT * FROM auth.hooks LIMIT 5");
    console.log('auth.hooks:', JSON.stringify(hooks.rows));
  } catch(e) {
    console.log('No auth.hooks table');
  }

  // 7. Check the "gotrue" schema or any gotrue-related tables
  try {
    const gt = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'gotrue'");
    console.log('\ngotrue schema tables:', gt.rows.map(r => r.table_name).join(', '));
  } catch(e) {}

  // 8. CRITICAL: Check if extensions are in the right place
  console.log('\n=== Extension check ===');
  const exts = await c.query("SELECT extname, nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY extname");
  exts.rows.forEach(r => console.log('  ' + r.extname + ' -> ' + r.nspname));

  // 9. Check if pgcrypto functions are accessible from auth schema
  console.log('\n=== Testing crypt() from auth search_path ===');
  try {
    await c.query("SET search_path TO auth");
    const cryptTest = await c.query("SELECT crypt('test', gen_salt('bf'))");
    console.log('crypt() works from auth search_path: YES');
    await c.query("RESET search_path");  
  } catch(e) {
    console.log('crypt() FAILED from auth search_path:', e.message);
    await c.query("RESET search_path").catch(() => {});
  }

  await c.end();
}

check().catch(e => console.error('FATAL:', e.message));
