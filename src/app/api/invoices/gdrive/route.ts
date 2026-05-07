import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
// v2 — force rebuild

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const folderKindParam = url.searchParams.get('folder_kind');
    const folderKind =
      folderKindParam === 'vendor_invoices' || folderKindParam === 'customer_invoices'
        ? folderKindParam
        : null;

    const supabase = createServiceRoleClient();

    // Fetch documents with OCR data
    let query = (supabase as any)
      .from('documents')
      .select('id, source_identifier, original_filename, file_url, file_mime_type, file_size_bytes, status, received_at, created_at, ocr_raw_text, ocr_confidence, document_type, classification_confidence, gdrive_folder_kind, gdrive_folder_id', { count: 'exact' })
      .eq('source', 'google_drive');

    if (folderKind === 'vendor_invoices') {
      query = query.eq('gdrive_folder_kind', 'vendor_invoices');
    } else if (folderKind === 'customer_invoices') {
      // Treat NULL (legacy rows) as customer_invoices to keep existing UI populated.
      query = query.or('gdrive_folder_kind.eq.customer_invoices,gdrive_folder_kind.is.null');
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // For processed documents, fetch linked invoice data
    const docs = data || [];
    const docIds = docs.filter((d: any) => d.status !== 'new' && d.status !== 'failed').map((d: any) => d.id);

    let invoiceMap: Record<string, any> = {};
    if (docIds.length > 0) {
      const { data: invoices } = await (supabase as any)
        .from('invoices')
        .select('id, document_id, invoice_number, invoice_date, due_date, vendor_name, vendor_code, bill_to_name, subtotal, tax_amount, total_amount, total_returns, total_credits, payment_terms, validation_status, export_status, exported_at, is_vendor_invoice, approval_status, rejection_reason')
        .in('document_id', docIds)
        .limit(500);

      if (invoices) {
        // Fetch line items for all invoices
        const invoiceIds = invoices.map((inv: any) => inv.id);
        let linesMap: Record<string, any[]> = {};
        if (invoiceIds.length > 0) {
          const { data: lines } = await (supabase as any)
            .from('invoice_lines')
            .select('invoice_id, line_number, description, sku_code, sku_name, quantity, unit_price, line_total, returned_quantity, credit_amount, return_date, return_reason')
            .in('invoice_id', invoiceIds)
            .order('line_number', { ascending: true })
            .limit(2000);

          if (lines) {
            for (const line of lines) {
              if (!linesMap[line.invoice_id]) linesMap[line.invoice_id] = [];
              linesMap[line.invoice_id].push(line);
            }
          }
        }

        for (const inv of invoices) {
          invoiceMap[inv.document_id] = { ...inv, lines: linesMap[inv.id] || [] };
        }
      }
    }

    // Merge invoice data into document records
    const enriched = docs.map((doc: any) => ({
      ...doc,
      invoice: invoiceMap[doc.id] || null,
    }));

    return NextResponse.json({ data: enriched, total: count || 0 });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
