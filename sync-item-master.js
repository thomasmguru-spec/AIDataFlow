/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * sync-item-master.js
 *
 * One-shot script to populate the `item_master` table from Silo without
 * needing to hit the deployed API. Run with:
 *
 *   node sync-item-master.js
 *
 * Requires the same env as the app (NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, SILO_EMAIL, SILO_PASSWORD).
 */
require('dotenv').config({ path: '.env.local' });

const BASE = process.env.SYNC_BASE_URL || 'http://localhost:3000';

(async () => {
  const url = `${BASE.replace(/\/$/, '')}/api/item-master/sync`;
  console.log(`POST ${url}`);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    console.log(`HTTP ${res.status} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    console.log(JSON.stringify(json, null, 2));
    process.exit(res.ok && json.ok !== false ? 0 : 1);
  } catch (err) {
    console.error('Sync failed:', err);
    process.exit(1);
  }
})();
