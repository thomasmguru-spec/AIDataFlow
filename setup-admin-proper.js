const { Client } = require('pg');
const https = require('https');

const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhY2FzcXFiYW1mYnRvbnRkZGZpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTQ1NTI3NiwiZXhwIjoyMDkxMDMxMjc2fQ.uuiwe2aFRDdQLLJpsMbgSUQ3zLZAJywpNj7X9QuomEE';

const pgClient = new Client({
  host: 'db.lacasqqbamfbtontddfi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false }
});

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: 'lacasqqbamfbtontddfi.supabase.co',
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + SERVICE_ROLE_KEY,
        ...(body ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(postData);
    req.end();
  });
}

async function main() {
  // Step 1: Clean up manually created users from database
  console.log('=== Step 1: Clean up manual users ===');
  await pgClient.connect();
  
  const existing = await pgClient.query("SELECT id FROM auth.users WHERE email = 'admin@sankaj.com'");
  for (const row of existing.rows) {
    const uid = row.id;
    console.log('Removing manually created user:', uid);
    await pgClient.query("DELETE FROM user_profiles WHERE id = $1", [uid]);
    await pgClient.query("DELETE FROM auth.mfa_amr_claims WHERE session_id IN (SELECT id FROM auth.sessions WHERE user_id = $1)", [uid]);
    await pgClient.query("DELETE FROM auth.refresh_tokens WHERE user_id = $1::text", [uid]);
    await pgClient.query("DELETE FROM auth.sessions WHERE user_id = $1", [uid]);
    await pgClient.query("DELETE FROM auth.identities WHERE user_id = $1", [uid]);
    await pgClient.query("DELETE FROM auth.users WHERE id = $1", [uid]);
    console.log('Deleted.');
  }
  if (existing.rows.length === 0) console.log('No existing user to clean up.');

  // Step 2: Create user via Supabase Admin API (GoTrue handles everything properly)
  console.log('\n=== Step 2: Create user via Admin API ===');
  const createRes = await apiCall('POST', '/auth/v1/admin/users', {
    email: 'admin@sankaj.com',
    password: 'Admin@12345',
    email_confirm: true,
    user_metadata: { full_name: 'Admin User' },
    app_metadata: { provider: 'email', providers: ['email'] }
  });
  
  console.log('Status:', createRes.status);
  
  if (createRes.status === 200 || createRes.status === 201) {
    const user = createRes.data;
    console.log('User created successfully!');
    console.log('User ID:', user.id);
    console.log('Email:', user.email);
    console.log('Confirmed:', user.email_confirmed_at ? 'Yes' : 'No');
    
    // Step 2b: Create user_profiles entry
    console.log('\nCreating user_profiles entry...');
    await pgClient.query(
      "INSERT INTO user_profiles (id, full_name, role, email) VALUES ($1, 'Admin User', 'admin', 'admin@sankaj.com')",
      [user.id]
    );
    console.log('Profile created with admin role.');
  } else {
    console.log('Error:', JSON.stringify(createRes.data));
  }

  await pgClient.end();

  // Step 3: Test login
  console.log('\n=== Step 3: Test Login ===');
  const loginRes = await apiCall('POST', '/auth/v1/token?grant_type=password', {
    email: 'admin@sankaj.com',
    password: 'Admin@12345'
  });

  if (loginRes.status === 200) {
    console.log('\n*** LOGIN SUCCESS! ***');
    console.log('Email:', loginRes.data.user?.email);
    console.log('Access token received:', !!loginRes.data.access_token);
    console.log('Refresh token received:', !!loginRes.data.refresh_token);
    console.log('\n=============================');
    console.log('  Email:    admin@sankaj.com');
    console.log('  Password: Admin@12345');
    console.log('  Role:     admin');
    console.log('=============================');
  } else {
    console.log('Login Status:', loginRes.status);
    console.log('Error:', JSON.stringify(loginRes.data));
  }
}

main().catch(e => console.error('FATAL:', e.message));
