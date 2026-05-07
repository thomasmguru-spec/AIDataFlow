import { createAdminClient } from '@/lib/supabase/admin';
import { Parser } from 'json2csv';

export interface SiloExportOptions {
  /**
   * 'all'           — export every validated record (legacy behaviour).
   * 'test_approved' — only records explicitly approved (approval_status='approved').
   *                   Each row is stamped with TEST_DATE 1000-01-01 so the trial run
   *                   is identifiable in Silo / downstream systems.
   */
  mode?: 'all' | 'test_approved';
}

const TEST_DATE = '1000-01-01';

export async function generateSiloExport(opts: SiloExportOptions = {}): Promise<{
  invoiceCount: number;
  orderCount: number;
  batchId: string;
  mode: 'all' | 'test_approved';
  testDate: string | null;
}> {
  const mode = opts.mode || 'all';
  const isTest = mode === 'test_approved';
  const supabase = createAdminClient();
  const batchId = `${isTest ? 'SILOTEST' : 'SILO'}_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  const ts = new Date().toISOString();

  // ── Export Invoices ──
  let invoiceQuery = supabase
    .from('invoices')
    .select('*, invoice_lines(*)')
    .eq('validation_status', 'passed')
    .not('vendor_name', 'in', '("Sankaj","Supply Seva")')
    .or('export_status.is.null,export_status.eq.pending')
    .limit(500);
  if (isTest) invoiceQuery = (invoiceQuery as any).eq('approval_status', 'approved');

  const { data: invoices } = await invoiceQuery;

  let invoiceCount = 0;

  if (invoices && invoices.length > 0) {
    // Build flat rows for CSV
    const rows: Record<string, unknown>[] = [];
    for (const inv of invoices) {
      const lines = (inv as any).invoice_lines as any[] || [];
      if (lines.length === 0) {
        rows.push({
          batch_id: batchId,
          record_type: 'INVOICE',
          invoice_number: inv.invoice_number,
          invoice_date: isTest ? TEST_DATE : inv.invoice_date,
          vendor_name: inv.vendor_name,
          vendor_code: inv.vendor_code,
          subtotal: inv.subtotal,
          tax_amount: inv.tax_amount,
          total_amount: inv.total_amount,
          payment_terms: inv.payment_terms,
          due_date: isTest ? TEST_DATE : inv.due_date,
          test_date: isTest ? TEST_DATE : null,
          line_number: null,
          sku_code: null,
          description: null,
          quantity: null,
          unit_price: null,
          line_total: null,
        });
      } else {
        for (const li of lines) {
          rows.push({
            batch_id: batchId,
            record_type: 'INVOICE',
            invoice_number: inv.invoice_number,
            invoice_date: isTest ? TEST_DATE : inv.invoice_date,
            vendor_name: inv.vendor_name,
            vendor_code: inv.vendor_code,
            subtotal: inv.subtotal,
            tax_amount: inv.tax_amount,
            total_amount: inv.total_amount,
            payment_terms: inv.payment_terms,
            due_date: isTest ? TEST_DATE : inv.due_date,
            test_date: isTest ? TEST_DATE : null,
            line_number: li.line_number,
            sku_code: li.sku_code,
            description: li.description,
            quantity: li.quantity,
            unit_price: li.unit_price,
            line_total: li.line_total,
          });
        }
      }
    }

    const parser = new Parser();
    const csv = parser.parse(rows);
    const filename = `invoices_${batchId}.csv`;
    const storagePath = `exports/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from('silo-exports')
      .upload(storagePath, Buffer.from(csv), { contentType: 'text/csv' });

    if (!uploadError) {
      const { data: { publicUrl } } = supabase.storage.from('silo-exports').getPublicUrl(storagePath);

      // Mark invoices as exported
      const ids = invoices.map((i) => i.id);
      await supabase
        .from('invoices')
        .update({
          export_status: 'exported',
          export_batch_id: batchId,
          export_csv_url: publicUrl,
          exported_at: ts,
        } as any)
        .in('id', ids);

      // Update documents status
      const docIds = invoices.map((i) => i.document_id);
      await supabase
        .from('documents')
        .update({ status: 'exported', exported_at: ts } as any)
        .in('id', docIds);

      invoiceCount = invoices.length;
    }
  }

  // ── Export Orders ──
  let orderQuery = supabase
    .from('orders')
    .select('*, order_lines(*)')
    .eq('validation_status', 'passed')
    .or('export_status.is.null,export_status.eq.pending')
    .limit(500);
  if (isTest) orderQuery = (orderQuery as any).eq('approval_status', 'approved');

  const { data: orders } = await orderQuery;

  let orderCount = 0;

  if (orders && orders.length > 0) {
    const rows: Record<string, unknown>[] = [];
    for (const ord of orders) {
      const lines = (ord as any).order_lines as any[] || [];
      if (lines.length === 0) {
        rows.push({
          batch_id: batchId,
          record_type: 'ORDER',
          order_number: ord.order_number,
          order_date: isTest ? TEST_DATE : ord.order_date,
          customer_name: ord.customer_name,
          customer_code: ord.customer_code,
          shipping_address: ord.shipping_address,
          total_amount: ord.total_amount,
          delivery_date: isTest ? TEST_DATE : ord.delivery_date,
          test_date: isTest ? TEST_DATE : null,
          special_instructions: ord.special_instructions,
          line_number: null,
          sku_code: null,
          description: null,
          quantity: null,
          unit_price: null,
          line_total: null,
        });
      } else {
        for (const li of lines) {
          rows.push({
            batch_id: batchId,
            record_type: 'ORDER',
            order_number: ord.order_number,
            order_date: isTest ? TEST_DATE : ord.order_date,
            customer_name: ord.customer_name,
            customer_code: ord.customer_code,
            shipping_address: ord.shipping_address,
            total_amount: ord.total_amount,
            delivery_date: isTest ? TEST_DATE : ord.delivery_date,
            test_date: isTest ? TEST_DATE : null,
            special_instructions: ord.special_instructions,
            line_number: li.line_number,
            sku_code: li.sku_code,
            description: li.description,
            quantity: li.quantity,
            unit_price: li.unit_price,
            line_total: li.line_total,
          });
        }
      }
    }

    const parser = new Parser();
    const csv = parser.parse(rows);
    const filename = `orders_${batchId}.csv`;
    const storagePath = `exports/${filename}`;

    const { error: uploadError } = await supabase.storage
      .from('silo-exports')
      .upload(storagePath, Buffer.from(csv), { contentType: 'text/csv' });

    if (!uploadError) {
      const { data: { publicUrl } } = supabase.storage.from('silo-exports').getPublicUrl(storagePath);

      const ids = orders.map((o) => o.id);
      await supabase
        .from('orders')
        .update({
          export_status: 'exported',
          export_batch_id: batchId,
          export_csv_url: publicUrl,
          exported_at: ts,
        } as any)
        .in('id', ids);

      const docIds = orders.map((o) => o.document_id);
      await supabase
        .from('documents')
        .update({ status: 'exported', exported_at: ts } as any)
        .in('id', docIds);

      orderCount = orders.length;
    }
  }

  return { invoiceCount, orderCount, batchId, mode, testDate: isTest ? TEST_DATE : null };
}
