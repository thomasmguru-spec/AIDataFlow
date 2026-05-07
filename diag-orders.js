require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  const folderId = process.env.GDRIVE_ORDERS_FOLDER_ID;
  // status counts (split into two queries since .or doesn't paginate well)
  const { data: docs, error } = await s
    .from('documents')
    .select('id,original_filename,file_mime_type,status,document_type,ocr_word_count,ocr_confidence')
    .or(`gdrive_folder_kind.eq.orders,gdrive_folder_id.eq.${folderId}`)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) { console.error(error); return; }
  console.log('TOTAL DOCS:', docs.length);
  const statusCounts = {};
  const mimeCounts = {};
  docs.forEach(d => {
    statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
    mimeCounts[d.file_mime_type] = (mimeCounts[d.file_mime_type] || 0) + 1;
  });
  console.log('STATUS:', statusCounts);
  console.log('MIME:', mimeCounts);

  // Sample some exception orders
  const exDocs = docs.filter(d => d.status === 'exception').slice(0, 5);
  const ids = exDocs.map(d => d.id);
  const { data: ords } = await s
    .from('orders')
    .select('id,document_id,order_number,customer_name,customer_phone,customer_email,total_amount,delivery_date,shipping_address,exception_status,exception_reason,validation_status,field_confidences')
    .in('document_id', ids);
  const ordersByDoc = new Map((ords || []).map(o => [o.document_id, o]));
  for (const d of exDocs) {
    const o = ordersByDoc.get(d.id);
    const { data: lines } = o ? await s.from('order_lines').select('line_number,sku_name,description,quantity').eq('order_id', o.id) : { data: [] };
    console.log('\n---');
    console.log('DOC:', d.original_filename, '| status:', d.status, '| words:', d.ocr_word_count, '| conf:', d.ocr_confidence);
    console.log('ORDER:', o ? { customer: o.customer_name, order_num: o.order_number, total: o.total_amount, delivery: o.delivery_date, addr: o.shipping_address, ex_reason: o.exception_reason } : 'NO ORDER ROW');
    console.log('LINES:', lines?.length || 0, lines?.slice(0, 3));
  }
})();
