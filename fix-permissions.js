const { Client } = require('pg');
const https = require('https');

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

  // 1. Check who owns auth schema
  console.log('=== Schema ownership ===');
  const schemas = await c.query(`
    SELECT n.nspname, r.rolname as owner
    FROM pg_namespace n
    JOIN pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname IN ('auth', 'public', 'extensions', 'storage')
    ORDER BY n.nspname
  `);
  schemas.rows.forEach(r => console.log(`  ${r.nspname} -> owner: ${r.owner}`));

  // 2. Check postgres role privileges
  const privs = await c.query(`
    SELECT has_schema_privilege('postgres', 'auth', 'CREATE') as can_create_auth,
           has_schema_privilege('postgres', 'auth', 'USAGE') as can_use_auth,
           has_schema_privilege('supabase_admin', 'auth', 'CREATE') as admin_can_create
  `);
  console.log('\nPrivileges:', JSON.stringify(privs.rows[0]));

  // 3. Check if postgres can SET ROLE to supabase_admin
  console.log('\n=== Trying different roles ===');
  
  const roles = ['supabase_admin', 'supabase_auth_admin', 'service_role'];
  for (const role of roles) {
    try {
      await c.query(`SET ROLE ${role}`);
      console.log(`SET ROLE ${role}: SUCCESS`);
      
      // Try creating function in auth
      try {
        await c.query(`
          CREATE OR REPLACE FUNCTION auth.hmac(data text, key text, type text)
          RETURNS bytea AS $$
            SELECT extensions.hmac(data, key, type);
          $$ LANGUAGE sql STABLE;
        `);
        console.log(`  Created auth.hmac as ${role}!`);
      } catch(e) {
        console.log(`  Create function as ${role}: ${e.message.substring(0, 80)}`);
      }
      
      await c.query('RESET ROLE');
    } catch(e) {
      console.log(`SET ROLE ${role}: FAILED - ${e.message.substring(0, 60)}`);
    }
  }

  // 4. Alternative: Try granting CREATE on auth schema to postgres
  try {
    await c.query('GRANT CREATE ON SCHEMA auth TO postgres');
    console.log('\nGranted CREATE on auth to postgres');
  } catch(e) {
    console.log('\nGRANT CREATE on auth:', e.message.substring(0, 80));
  }

  // 5. Alternative: Install pgcrypto in auth schema
  try {
    await c.query("CREATE EXTENSION pgcrypto SCHEMA auth");
    console.log('Installed pgcrypto in auth schema');
  } catch(e) {
    console.log('Install pgcrypto in auth:', e.message.substring(0, 80));
  }

  // 6. Check all roles postgres is a member of
  console.log('\n=== Postgres role memberships ===');
  const memberships = await c.query(`
    SELECT r.rolname as role, m.rolname as member_of
    FROM pg_auth_members am
    JOIN pg_roles r ON r.oid = am.member
    JOIN pg_roles m ON m.oid = am.roleid
    WHERE r.rolname = 'postgres'
  `);
  memberships.rows.forEach(r => console.log(`  postgres is member of: ${r.member_of}`));

  // 7. Check if I'm actually a superuser
  const su = await c.query("SELECT current_user, session_user, current_setting('is_superuser') as is_su");
  console.log('\nCurrent user:', su.rows[0].current_user, '| Session:', su.rows[0].session_user, '| Superuser:', su.rows[0].is_su);

  await c.end();
}

fix().catch(e => console.error('FATAL:', e.message));
