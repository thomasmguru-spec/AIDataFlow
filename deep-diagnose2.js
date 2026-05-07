const { Client } = require('pg');

const c = new Client({
  host: 'db.lacasqqbamfbtontddfi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false }
});

async function fix() {
  await c.connect();

  const userId = 'b145dad8-4cc5-4d30-8b5d-2f7762197874';

  // 1. Check auth hooks (supabase_functions schema)
  try {
    const hooks = await c.query("SELECT * FROM supabase_functions.hooks");
    console.log('Auth hooks:', hooks.rows.length);
    hooks.rows.forEach(h => console.log(' ', JSON.stringify(h)));
  } catch(e) {
    console.log('No supabase_functions.hooks table:', e.message.substring(0, 80));
  }

  // 2. Check if there's an auth.config table
  try {
    const config = await c.query("SELECT * FROM auth.config");
    console.log('\nAuth config:');
    config.rows.forEach(r => console.log(' ', JSON.stringify(r)));
  } catch(e) {
    console.log('No auth.config table');
  }

  // 3. Check auth.sessions structure
  const sessCol = await c.query(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='auth' AND table_name='sessions' ORDER BY ordinal_position"
  );
  console.log('\nAuth sessions columns:');
  sessCol.rows.forEach(r => console.log(' ', r.column_name, r.data_type, r.is_nullable));

  // 4. Check auth.refresh_tokens structure  
  const rtCol = await c.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='auth' AND table_name='refresh_tokens' ORDER BY ordinal_position"
  );
  console.log('\nAuth refresh_tokens columns:');
  rtCol.rows.forEach(r => console.log(' ', r.column_name, r.data_type));

  // 5. Check if there are any auth triggers we missed
  const triggers = await c.query(`
    SELECT t.tgname, c.relname, n.nspname, p.proname as func_name, pn.nspname as func_schema
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace pn ON pn.oid = p.pronamespace
    WHERE n.nspname = 'auth'
  `);
  console.log('\nAll auth schema triggers:');
  triggers.rows.forEach(t => console.log(' ', t.relname + '.' + t.tgname, '->', t.func_schema + '.' + t.func_name));

  // 6. Check if there are event triggers
  const evTriggers = await c.query("SELECT evtname, evtevent, evtfoid::regproc FROM pg_event_trigger");
  console.log('\nEvent triggers:');
  evTriggers.rows.forEach(t => console.log(' ', t.evtname, t.evtevent, t.evtfoid));

  // 7. Try to manually INSERT into auth.sessions to see if it breaks
  console.log('\n=== Testing manual session creation ===');
  try {
    const sessionId = require('crypto').randomUUID();
    await c.query(`
      INSERT INTO auth.sessions (id, user_id, factor_id, aal, not_after, refreshed_at, user_agent, ip, tag)
      VALUES ($1, $2, NULL, 'aal1', NULL, NULL, 'test', '127.0.0.1'::inet, NULL)
    `, [sessionId, userId]);
    console.log('Session insert: OK');
    // Clean up
    await c.query("DELETE FROM auth.sessions WHERE id = $1", [sessionId]);
    console.log('Session cleanup: OK');
  } catch(e) {
    console.log('Session insert FAILED:', e.message);
    console.log('Detail:', e.detail || 'none');
  }

  // 8. Check for any function in auth schema that uses public schema
  const authFuncs = await c.query(`
    SELECT p.proname, pg_get_functiondef(p.oid) as def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'auth'
    AND pg_get_functiondef(p.oid) LIKE '%public.%'
  `);
  console.log('\nAuth functions referencing public schema:');
  if (authFuncs.rows.length === 0) console.log('  None');
  authFuncs.rows.forEach(f => console.log(' ', f.proname, '-', f.def.substring(0, 150)));

  await c.end();
}

fix().catch(e => console.error('Error:', e.message));
