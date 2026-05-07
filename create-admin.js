const { Client } = require('pg');
const crypto = require('crypto');

const c = new Client({
  host: 'db.lacasqqbamfbtontddfi.supabase.co',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'vR9EN7Q2?_#yLCp',
  ssl: { rejectUnauthorized: false }
});

async function createUser() {
  await c.connect();
  console.log('Connected.');

  const userId = crypto.randomUUID();
  const email = 'admin@sankaj.com';
  const now = new Date().toISOString();

  // Create user in auth.users using Supabase's internal format
  // Supabase uses gotrue which stores bcrypt hashes - we'll use crypt() function
  try {
    // First enable pgcrypto if not already
    await c.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

    // Insert into auth.users
    await c.query(`
      INSERT INTO auth.users (
        id, instance_id, email, encrypted_password, 
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data,
        aud, role, confirmation_token
      ) VALUES (
        $1, '00000000-0000-0000-0000-000000000000', $2, 
        crypt('Admin@12345', gen_salt('bf')),
        $3, $3, $3,
        '{"provider": "email", "providers": ["email"]}'::jsonb,
        '{"full_name": "Admin User"}'::jsonb,
        'authenticated', 'authenticated', ''
      )
    `, [userId, email, now]);

    console.log('Auth user created!');
    console.log('User ID:', userId);

    // Create user profile  
    await c.query(`
      INSERT INTO user_profiles (id, full_name, role, email)
      VALUES ($1, 'Admin User', 'admin', $2)
    `, [userId, email]);

    console.log('User profile created with admin role!');

    // Also create an identity record (required for email login)
    await c.query(`
      INSERT INTO auth.identities (
        id, user_id, identity_data, provider, provider_id,
        last_sign_in_at, created_at, updated_at
      ) VALUES (
        $1::uuid, $1::uuid, 
        jsonb_build_object('sub', $1, 'email', $2, 'email_verified', true),
        'email', $1,
        $3, $3, $3
      )
    `, [userId, email, now]);

    console.log('Identity record created!');
    console.log('\n=== LOGIN CREDENTIALS ===');
    console.log('Email:    admin@sankaj.com');
    console.log('Password: Admin@12345');
    console.log('Role:     admin');
    console.log('=========================');

  } catch (e) {
    console.error('Error:', e.message);
    if (e.detail) console.error('Detail:', e.detail);
  }

  await c.end();
}

createUser();
