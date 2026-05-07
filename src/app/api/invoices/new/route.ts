import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const supabase = createServiceRoleClient();
    const { searchParams } = req.nextUrl;
    const limit = Math.min(Number(searchParams.get('limit') || '50'), 200);
    const offset = Number(searchParams.get('offset') || '0');
    const sourceParam = searchParams.get('source') || '';
    const allSources = ['whatsapp', 'email', 'scanner', 'google_drive', 'cloud_upload'];
    const sourceList = sourceParam
      ? sourceParam.split(',').map(s => s.trim()).filter(Boolean)
      : allSources;

    let query = supabase
      .from('invoices')
      .select(`
        id, invoice_number, invoice_date, due_date, vendor_name, vendor_code,
        vendor_address, vendor_email, vendor_phone,
        bill_to_name, bill_to_address,
        subtotal, tax_amount, total_amount, payment_terms,
        validation_status, exception_status, export_status, exported_at,
        approval_status, reviewed_by, reviewed_at, approved_by, approved_at, rejection_reason,
        created_at, updated_at,
        document_id,
        documents!inner(id, source, original_filename, received_at, source_identifier, file_url, file_mime_type, ocr_raw_text, ocr_confidence)
      `, { count: 'exact' })
      .in('documents.source', sourceList)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, count, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Fetch invoice_lines for all returned invoices
    const invoiceIds = (data || []).map((inv: any) => inv.id);
    let linesMap: Record<string, any[]> = {};
    if (invoiceIds.length > 0) {
      const { data: linesData } = await supabase
        .from('invoice_lines')
        .select('invoice_id, line_number, description, sku_code, sku_name, quantity, unit_price, line_total')
        .in('invoice_id', invoiceIds)
        .order('line_number');
      for (const line of (linesData || [])) {
        if (!linesMap[line.invoice_id]) linesMap[line.invoice_id] = [];
        linesMap[line.invoice_id].push(line);
      }
    }

    // Attach lines to each invoice
    const enriched = (data || []).map((inv: any) => ({
      ...inv,
      lines: linesMap[inv.id] || [],
    }));

    return NextResponse.json({ data: enriched, total: count ?? 0 });
  } catch (err) {
    console.error('New invoices API error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
