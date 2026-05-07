require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  // Check the failed document
  const { data, error } = await supabase
    .from('documents')
    .select('id, original_filename, file_url, source, source_identifier, status, error_message, processing_log, file_mime_type')
    .eq('id', '71f98d15-0092-4ebe-9101-444da63d692d')
    .single();

  if (error) {
    console.error('Query error:', error);
    return;
  }

  console.log('Document:', JSON.stringify(data, null, 2));

  // Also check a few other recent failed docs
  const { data: failedDocs } = await supabase
    .from('documents')
    .select('id, original_filename, status, error_message')
    .eq('status', 'failed')
    .order('updated_at', { ascending: false })
    .limit(5);

  console.log('\nRecent failed docs:');
  failedDocs?.forEach(d => {
    console.log(`  ${d.original_filename}: ${d.error_message}`);
  });
}

check().catch(err => console.error('Fatal:', err));
