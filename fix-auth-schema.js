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
  console.log('Connected.\n');

  // 1. Check function ownership - SECURITY DEFINER functions must be owned by postgres
  const funcs = await c.query(`
    SELECT n.nspname, p.proname, r.rolname as owner, p.prosecdef as security_definer
    FROM pg_proc p 
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.proname IN ('get_user_role', 'is_admin', 'is_reviewer_or_admin')
  `);
  console.log('=== Function ownership ===');
  funcs.rows.forEach(f => console.log(f.proname, '| owner:', f.owner, '| sec_definer:', f.security_definer));

  // 2. The key fix: add a service_role bypass policy for user_profiles
  // GoTrue uses the supabase_auth_admin role internally, which needs access
  console.log('\n=== Fixing RLS policies ===');

  // Add policy for supabase_auth_admin to access user_profiles (GoTrue needs this)
  try {
    await c.query(`
      CREATE POLICY "Auth admin can access profiles"
        ON user_profiles FOR ALL
        USING (true)
        WITH CHECK (true)
    `);
    // This is too permissive, let me be more specific
    await c.query(`DROP POLICY IF EXISTS "Auth admin can access profiles" ON user_profiles`);
  } catch(e) { /* ignore */ }

  // Grant supabase_auth_admin access to user_profiles
  try {
    await c.query(`GRANT SELECT ON user_profiles TO supabase_auth_admin`);
    console.log('Granted SELECT on user_profiles to supabase_auth_admin');
  } catch(e) {
    console.log('supabase_auth_admin grant:', e.message);
  }

  // Add policy for service_role to bypass RLS
  try {
    await c.query(`DROP POLICY IF EXISTS "Service role bypass" ON user_profiles`);
    await c.query(`
      CREATE POLICY "Service role bypass"
        ON user_profiles FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true)
    `);
    console.log('Added service_role bypass policy on user_profiles');
  } catch(e) {
    console.log('Service role policy:', e.message);
  }

  // Add policy for postgres role  
  try {
    await c.query(`DROP POLICY IF EXISTS "Postgres bypass" ON user_profiles`);
    await c.query(`
      CREATE POLICY "Postgres bypass"
        ON user_profiles FOR ALL
        TO postgres
        USING (true)
        WITH CHECK (true)
    `);
    console.log('Added postgres bypass policy on user_profiles');
  } catch(e) {
    console.log('Postgres policy:', e.message);
  }

  // Add policy for supabase_auth_admin  
  try {
    await c.query(`DROP POLICY IF EXISTS "Auth admin bypass" ON user_profiles`);
    await c.query(`
      CREATE POLICY "Auth admin bypass"
        ON user_profiles FOR ALL
        TO supabase_auth_admin
        USING (true)
        WITH CHECK (true)
    `);
    console.log('Added supabase_auth_admin bypass policy on user_profiles');
  } catch(e) {
    console.log('Auth admin policy:', e.message);
  }

  // 3. Also add service_role bypass on ALL tables with RLS (for backend processing)
  const rlsTables = [
    'master_skus', 'master_customers', 'master_vendors', 'vendor_templates',
    'documents', 'document_preprocessed', 'document_ocr_results',
    'invoices', 'invoice_line_items', 'orders', 'order_line_items',
    'validation_results', 'exceptions', 'exception_comments',
    'silo_exports', 'silo_export_items', 'processing_logs',
    'audit_logs', 'daily_summaries', 'notifications'
  ];
  
  for (const table of rlsTables) {
    try {
      await c.query(`DROP POLICY IF EXISTS "Service role bypass" ON ${table}`);
      await c.query(`
        CREATE POLICY "Service role bypass"
          ON ${table} FOR ALL
          TO service_role
          USING (true)
          WITH CHECK (true)
      `);
    } catch(e) {
      console.log(`${table} service_role policy:`, e.message);
    }
  }
  console.log('Added service_role bypass on all', rlsTables.length, 'tables');

  // 4. Reload PostgREST schema cache
  await c.query("NOTIFY pgrst, 'reload schema'");
  console.log('\nPostgREST schema cache reloaded');

  // 5. Verify all policies on user_profiles
  const policies = await c.query(
    "SELECT policyname, cmd, roles FROM pg_policies WHERE tablename = 'user_profiles' ORDER BY policyname"
  );
  console.log('\n=== Final user_profiles policies ===');
  policies.rows.forEach(p => console.log(p.policyname, '|', p.cmd, '| roles:', p.roles));

  await c.end();
  console.log('\nDone! Try login now.');
}

fix().catch(e => console.error('Error:', e.message, e.detail || ''));
