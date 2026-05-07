// Update admin email via Supabase Admin API (REST)
const SUPABASE_URL = 'https://lacasqqbamfbtontddfi.supabase.co';
const SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhY2FzcXFiYW1mYnRvbnRkZGZpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTQ1NTI3NiwiZXhwIjoyMDkxMDMxMjc2fQ.uuiwe2aFRDdQLLJpsMbgSUQ3zLZAJywpNj7X9QuomEE';

const headers = {
  'apikey': SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

(async () => {
  // Step 1: Find the admin user
  const listRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=50`, { headers });
  const listData = await listRes.json();
  const users = listData.users || listData;
  const admin = users.find(u => u.email === 'admin@sankaj.com');

  if (!admin) {
    console.log('No user found with admin@sankaj.com');
    console.log('Existing users:', users.map(u => u.email));
    return;
  }

  console.log('Found admin user:', admin.id, admin.email);

  // Step 2: Update email via Admin API
  const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${admin.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      email: 'admin@sankaj.com',
      email_confirm: true,
      user_metadata: { ...admin.user_metadata, email: 'admin@sankaj.com' },
      app_metadata: { ...admin.app_metadata, email: 'admin@sankaj.com' },
    }),
  });

  const updateData = await updateRes.json();
  if (!updateRes.ok) {
    console.error('Failed to update auth user:', updateData);
    return;
  }
  console.log('Auth user email updated to:', updateData.email);

  // Step 3: Update user_profiles table
  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${admin.id}`,
    {
      method: 'PATCH',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({ email: 'admin@sankaj.com' }),
    }
  );
  const profileData = await profileRes.json();
  console.log('user_profiles updated:', profileData.length > 0 ? 'success' : 'no matching row (may not exist)');

  console.log('\\nDone! New login credentials:');
  console.log('  Email:    admin@sankaj.com');
  console.log('  Password: Admin@12345');
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
