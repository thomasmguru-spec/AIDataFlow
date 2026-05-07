// Sequentially re-process every Google Drive document currently in
// `exception` state, hitting the local /api/process endpoint.
//
// Usage: node reprocess-exceptions.js [folder_kind]
//   folder_kind: optional, e.g. 'orders' (default = all)

require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const folderKind = process.argv[2] || null;
const ENDPOINT = process.env.PROCESS_ENDPOINT || 'http://localhost:3000/api/process';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  let q = supabase
    .from('documents')
    .select('id, original_filename, gdrive_folder_kind, status')
    .eq('source', 'google_drive')
    .eq('status', 'exception');
  if (folderKind) q = q.eq('gdrive_folder_kind', folderKind);
  const { data, error } = await q;
  if (error) throw error;
  console.log(`Found ${data.length} exception docs${folderKind ? ` (folder=${folderKind})` : ''}`);

  let ok = 0, exc = 0, fail = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    process.stdout.write(`[${i + 1}/${data.length}] ${d.id} ${d.original_filename}  `);
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 600_000); // 10 min hard cap
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: d.id }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      const json = await res.json().catch(() => ({}));
      const status = json?.result?.status || 'unknown';
      console.log(`→ ${status}`);
      if (status === 'ready_for_export' || status === 'validated') ok++;
      else if (status === 'exception') exc++;
      else fail++;
    } catch (e) {
      console.log(`→ ERR ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDONE — ok=${ok} exception=${exc} failed=${fail} (of ${data.length})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
