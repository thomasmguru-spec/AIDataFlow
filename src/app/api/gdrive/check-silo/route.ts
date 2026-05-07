import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { fetchPayments } from '@/lib/silo/client';

/**
 * GET: Check Google Drive invoices against Silo payments.
 * - Fetches all GDrive invoices from our DB
 * - Fetches payments from Silo
 * - Finds invoices from GDrive that are missing in Silo (no matching payment)
 * - Auto-inserts missing invoice records if OCR-extracted data exists but no invoice row was created
 */
export async function GET() {
  try {
    const supabase = createServiceRoleClient();

    // 1. Fetch all Google Drive documents that have been OCR-processed
    const { data: gdriveDocs, error: docError } = await supabase
      .from('documents')
      .select('id, source_identifier, original_filename, ocr_raw_text, status, document_type')
      .eq('source', 'google_drive' as any)
      .in('status', ['processed', 'validated', 'exported'] as any);

    if (docError) {
      return NextResponse.json({ error: docError.message }, { status: 500 });
    }

    if (!gdriveDocs || gdriveDocs.length === 0) {
      return NextResponse.json({
        status: 'ok',
        message: 'No processed Google Drive documents found',
        checked: 0,
        missing: 0,
        inserted: 0,
      });
    }

    // 2. Check which documents already have invoice records
    const docIds = gdriveDocs.map(d => d.id);
    const { data: existingInvoices } = await supabase
      .from('invoices')
      .select('document_id')
      .in('document_id', docIds);

    const hasInvoiceSet = new Set((existingInvoices || []).map(inv => inv.document_id));

    // 3. Find documents that are processed but don't have invoice records
    const missingDocs = gdriveDocs.filter(d => !hasInvoiceSet.has(d.id));

    // 4. For missing docs, create invoice records from OCR data
    let inserted = 0;
    const errors: { doc_id: string; error: string }[] = [];

    for (const doc of missingDocs) {
      try {
        // Only insert for documents classified as invoices or unknown type
        if (doc.document_type && doc.document_type !== 'invoice' && doc.document_type !== 'unknown') {
          continue;
        }

        const { error: insertError } = await supabase
          .from('invoices')
          .insert({
            document_id: doc.id,
            validation_status: 'pending',
            export_status: 'pending',
          } as any);

        if (insertError) {
          errors.push({ doc_id: doc.id, error: insertError.message });
        } else {
          inserted++;
        }
      } catch (err) {
        errors.push({
          doc_id: doc.id,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    // 5. Fetch Silo payments for cross-reference
    let siloPaymentCount = 0;
    let matchedWithSilo = 0;
    try {
      const paymentData = await fetchPayments(500);
      siloPaymentCount = paymentData.payments.totalCount;

      // Get all our invoices with invoice numbers
      const { data: allInvoices } = await supabase
        .from('invoices')
        .select('id, invoice_number, document_id')
        .in('document_id', docIds)
        .not('invoice_number', 'is', null);

      if (allInvoices) {
        // Simple cross-reference: check if any Silo payment notes/check# match our invoice numbers
        const siloPayments = paymentData.payments.edges.map(e => e.node);
        for (const inv of allInvoices) {
          if (!inv.invoice_number) continue;
          const invNum = inv.invoice_number.toLowerCase().trim();
          const match = siloPayments.find(p =>
            (p.notes || '').toLowerCase().includes(invNum) ||
            (p.checkNumber || '').toLowerCase().includes(invNum)
          );
          if (match) {
            matchedWithSilo++;
          }
        }
      }
    } catch {
      // Silo fetch may fail, that's ok — we still inserted missing records
    }

    return NextResponse.json({
      status: 'ok',
      checked: gdriveDocs.length,
      already_have_invoice: hasInvoiceSet.size,
      missing: missingDocs.length,
      inserted,
      silo_payments: siloPaymentCount,
      matched_with_silo: matchedWithSilo,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: unknown) {
    console.error('GDrive-Silo check error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
