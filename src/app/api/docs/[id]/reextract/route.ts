/**
 * POST /api/docs/[id]/reextract
 *
 * Re-extracts fields and line items from a document that already has OCR text
 * but no (or a stale) invoice record.  Unlike /api/invoices/[id]/reextract
 * this endpoint takes a *document* id and will CREATE a new invoice if one
 * does not yet exist.
 *
 * Use this for documents stuck in "extracted" status (OCR done, pipeline
 * timed-out before invoice creation).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { extractInvoiceFields, extractFromFilename } from '@/lib/processing/extractor';
import { mapDocumentWithLlm, isLlmMapperAvailable, type MappedDocument } from '@/lib/processing/llm-mapper';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function firstNonEmpty<T>(...values: (T | null | undefined)[]): T | null {
  for (const v of values) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function scrub(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = String(v).trim();
  if (!t || t.length < 3) return null;
  if (/^(items?|total|qty|date|order|po|amount|price|subtotal|tax|note|name)$/i.test(t)) return null;
  if (/^[a-zA-Z]{1,5}$/.test(t)) return null;
  if (!/\d/.test(t)) return null;
  return t;
}

function sanitiseDate(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const ts = Date.parse(t);
  if (Number.isFinite(ts)) {
    const d = new Date(ts);
    if (d.getFullYear() > 1990 && d.getFullYear() < 2100) return d.toISOString().slice(0, 10);
  }
  return null;
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const documentId = params.id;
  if (!documentId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const supabase = createServiceRoleClient();

  // 1. Fetch the document
  const { data: doc, error: docErr } = await (supabase as any)
    .from('documents')
    .select('id, ocr_raw_text, original_filename, gdrive_folder_kind, status')
    .eq('id', documentId)
    .single();

  if (docErr || !doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }
  if (!doc.ocr_raw_text) {
    return NextResponse.json({ error: 'No OCR text available — run "Run OCR" first' }, { status: 400 });
  }

  const ocrText: string = doc.ocr_raw_text;

  // 2. Run regex extractor
  const extracted = extractInvoiceFields(ocrText);

  // 3. Filename hints fallback
  const filenameHints = extractFromFilename(doc.original_filename || '');
  if (!extracted.invoiceNumber && filenameHints.invoiceNumber) extracted.invoiceNumber = filenameHints.invoiceNumber;
  if (!extracted.invoiceDate  && filenameHints.invoiceDate)   extracted.invoiceDate   = filenameHints.invoiceDate;
  if (!extracted.vendorName   && filenameHints.vendorName)    extracted.vendorName    = filenameHints.vendorName;

  // 4. LLM text enrichment (no vision — fast)
  let llm: MappedDocument | null = null;
  if (isLlmMapperAvailable()) {
    try { llm = await mapDocumentWithLlm(ocrText, 'invoice'); } catch { /* ignore */ }
  }

  // 5. Merge fields
  const finalInvoiceNumber = firstNonEmpty<string>(scrub(extracted.invoiceNumber), scrub(llm?.invoice_number ?? null));
  const finalInvoiceDate   = sanitiseDate(firstNonEmpty<string>(extracted.invoiceDate, llm?.invoice_date));
  const finalVendorName    = firstNonEmpty<string>(extracted.vendorName,   llm?.vendor_name);
  const finalBillToName    = firstNonEmpty<string>(extracted.billToName,   llm?.bill_to_name);
  const finalBillToAddress = firstNonEmpty<string>(extracted.billToAddress, llm?.bill_to_address);
  const finalTotal         = firstNonEmpty<number>(extracted.totalAmount,  llm?.total_amount);
  const finalSubtotal      = firstNonEmpty<number>(extracted.subtotal,     llm?.subtotal);
  const finalTax           = firstNonEmpty<number>(extracted.taxAmount,    llm?.tax_amount);
  const finalTerms         = firstNonEmpty<string>(extracted.paymentTerms, llm?.payment_terms);
  const finalDueDate       = sanitiseDate(firstNonEmpty<string>(extracted.dueDate, llm?.due_date));
  const isVendor           = doc.gdrive_folder_kind === 'vendor_invoices';

  // 6. Upsert invoice (by document_id)
  const { data: existing } = await (supabase as any)
    .from('invoices')
    .select('id')
    .eq('document_id', documentId)
    .maybeSingle();

  let invoiceId: string;
  let created = false;

  if (existing) {
    invoiceId = existing.id;
    await (supabase as any).from('invoices').update({
      ...(finalInvoiceNumber && { invoice_number: finalInvoiceNumber }),
      ...(finalInvoiceDate   && { invoice_date:   finalInvoiceDate }),
      ...(finalVendorName    && { vendor_name:    finalVendorName }),
      ...(finalBillToName    && { bill_to_name:   finalBillToName }),
      ...(finalBillToAddress && { bill_to_address: finalBillToAddress }),
      ...(finalTotal  != null && { total_amount:  finalTotal }),
      ...(finalSubtotal != null && { subtotal:    finalSubtotal }),
      ...(finalTax    != null && { tax_amount:    finalTax }),
      ...(finalTerms         && { payment_terms:  finalTerms }),
      ...(finalDueDate       && { due_date:        finalDueDate }),
    }).eq('id', invoiceId);
  } else {
    const { data: ins, error: insErr } = await (supabase as any)
      .from('invoices')
      .insert({
        document_id:      documentId,
        invoice_number:   finalInvoiceNumber,
        invoice_date:     finalInvoiceDate,
        vendor_name:      finalVendorName,
        bill_to_name:     finalBillToName,
        bill_to_address:  finalBillToAddress,
        total_amount:     finalTotal,
        subtotal:         finalSubtotal,
        tax_amount:       finalTax,
        payment_terms:    finalTerms,
        due_date:         finalDueDate,
        is_vendor_invoice: isVendor,
        approval_status:  'draft',
        validation_status: 'pending',
      })
      .select('id')
      .single();

    if (insErr || !ins) {
      return NextResponse.json({ error: 'Failed to create invoice: ' + insErr?.message }, { status: 500 });
    }
    invoiceId = ins.id;
    created = true;
  }

  // 7. Replace line items
  await (supabase as any).from('invoice_lines').delete().eq('invoice_id', invoiceId);

  const regexLines = extracted.lineItems;
  const llmLines   = llm?.line_items ?? [];
  const finalLines = regexLines.length > 0 ? regexLines : llmLines;

  let linesInserted = 0;
  if (finalLines.length > 0) {
    const llmByLine = new Map<number, MappedDocument['line_items'][number]>();
    if (llm) for (const li of llm.line_items) llmByLine.set(li.line_number, li);

    const lineRows = finalLines.map((item: any, idx: number) => {
      const llmLine = llmByLine.get(item.lineNumber ?? item.line_number) ?? llmByLine.get(idx + 1);
      const skuCode = item.skuRaw ?? item.sku_code ?? null;
      const desc    = item.description ?? null;
      const skuName = llmLine?.sku_name
        ?? (skuCode && desc ? `${skuCode} ${desc}`.trim() : desc ?? skuCode ?? null);
      return {
        invoice_id:  invoiceId,
        line_number: item.lineNumber ?? item.line_number ?? idx + 1,
        description: desc,
        sku_code:    skuCode,
        sku_name:    skuName,
        quantity:    item.quantity ?? null,
        unit_price:  item.unitPrice ?? item.unit_price ?? null,
        line_total:  item.lineTotal ?? item.line_total ?? null,
        field_confidences: llmLine ? { _llm_used: true } : {},
      };
    });

    const { error: lineErr } = await (supabase as any).from('invoice_lines').insert(lineRows);
    if (!lineErr) linesInserted = lineRows.length;
  }

  // 8. Mark document as ready_for_export (not all doc types allow 'processed')
  await (supabase as any)
    .from('documents')
    .update({ status: 'ready_for_export' })
    .eq('id', documentId);

  return NextResponse.json({
    ok: true,
    documentId,
    invoiceId,
    created,
    invoiceNumber: finalInvoiceNumber,
    linesInserted,
    source: regexLines.length > 0 ? 'regex' : llm ? 'llm_text' : 'none',
  });
}
