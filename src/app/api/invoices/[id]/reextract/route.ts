/**
 * POST /api/invoices/[id]/reextract
 *
 * Lightweight re-extraction that re-uses the OCR text already stored in the
 * DB (no image download, no Vision OCR, no vision-LLM).  Only the regex
 * extractor and the text-LLM run — typically completes in < 15 seconds,
 * well within Vercel's 60-second limit.
 *
 * Use this when the extraction logic has been improved (e.g. new item-code +
 * description table parser) and you want to refresh existing records without
 * re-running the expensive full pipeline.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { extractInvoiceFields, extractFromFilename } from '@/lib/processing/extractor';
import { mapDocumentWithLlm, isLlmMapperAvailable, EMPTY_LLM_DOC, type MappedDocument } from '@/lib/processing/llm-mapper';

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
  if (!t) return null;
  if (/^[a-zA-Z]{1,5}$/.test(t)) return null;
  if (/^(items?|total|qty|date|order|po|amount|price|subtotal|tax|note|name)$/i.test(t)) return null;
  if (t.length < 3) return null;
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
  const invoiceId = params.id;
  if (!invoiceId) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const supabase = createServiceRoleClient();

  // 1. Fetch the existing invoice + its document's OCR text
  const { data: invoice, error: invErr } = await (supabase as any)
    .from('invoices')
    .select('id, document_id, invoice_number, invoice_date, vendor_name, bill_to_name, total_amount')
    .eq('id', invoiceId)
    .single();

  if (invErr || !invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  const { data: doc, error: docErr } = await (supabase as any)
    .from('documents')
    .select('id, ocr_raw_text, original_filename, file_mime_type, gdrive_folder_kind')
    .eq('id', invoice.document_id)
    .single();

  if (docErr || !doc || !doc.ocr_raw_text) {
    return NextResponse.json({ error: 'Document or OCR text not found' }, { status: 404 });
  }

  const ocrText: string = doc.ocr_raw_text;

  // 2. Run regex extractor
  const extracted = extractInvoiceFields(ocrText);

  // 3. Filename hints fallback
  const filenameHints = extractFromFilename(doc.original_filename || '');
  if (!extracted.invoiceNumber && filenameHints.invoiceNumber) {
    extracted.invoiceNumber = filenameHints.invoiceNumber;
  }
  if (!extracted.invoiceDate && filenameHints.invoiceDate) {
    extracted.invoiceDate = filenameHints.invoiceDate;
  }
  if (!extracted.vendorName && filenameHints.vendorName) {
    extracted.vendorName = filenameHints.vendorName;
  }

  // 4. LLM text enrichment (no vision - fast)
  let llm: MappedDocument | null = null;
  if (isLlmMapperAvailable()) {
    try {
      llm = await mapDocumentWithLlm(ocrText, 'invoice');
    } catch {
      llm = null;
    }
  }

  // 5. Merge fields
  const finalInvoiceNumber = firstNonEmpty<string>(
    scrub(extracted.invoiceNumber),
    scrub(llm?.invoice_number ?? null)
  );
  const finalInvoiceDate = firstNonEmpty<string>(extracted.invoiceDate, llm?.invoice_date);
  const finalVendorName  = firstNonEmpty<string>(extracted.vendorName,  llm?.vendor_name);
  const finalBillToName  = firstNonEmpty<string>(extracted.billToName,  llm?.bill_to_name);
  const finalBillToAddress = firstNonEmpty<string>(extracted.billToAddress, llm?.bill_to_address);
  const finalTotal       = firstNonEmpty<number>(extracted.totalAmount, llm?.total_amount);
  const finalSubtotal    = firstNonEmpty<number>(extracted.subtotal,    llm?.subtotal);
  const finalTax         = firstNonEmpty<number>(extracted.taxAmount,   llm?.tax_amount);
  const finalTerms       = firstNonEmpty<string>(extracted.paymentTerms, llm?.payment_terms);
  const finalDueDate     = firstNonEmpty<string>(extracted.dueDate,     llm?.due_date);

  // 6. Decide line items: prefer regex if found, else LLM
  const regexLines = extracted.lineItems;
  const llmLines   = llm?.line_items ?? [];
  const useRegex   = regexLines.length > 0;
  const finalLines = useRegex ? regexLines : llmLines;

  // 7. Update the invoice header (only override fields that we found something for)
  const updatePayload: Record<string, unknown> = {};
  if (finalInvoiceNumber) updatePayload.invoice_number = finalInvoiceNumber;
  if (finalInvoiceDate)   updatePayload.invoice_date   = sanitiseDate(finalInvoiceDate);
  if (finalVendorName)    updatePayload.vendor_name    = finalVendorName;
  if (finalBillToName)    updatePayload.bill_to_name   = finalBillToName;
  if (finalBillToAddress) updatePayload.bill_to_address = finalBillToAddress;
  if (finalTotal != null) updatePayload.total_amount   = finalTotal;
  if (finalSubtotal != null) updatePayload.subtotal    = finalSubtotal;
  if (finalTax != null)   updatePayload.tax_amount     = finalTax;
  if (finalTerms)         updatePayload.payment_terms  = finalTerms;
  if (finalDueDate)       updatePayload.due_date       = sanitiseDate(finalDueDate);

  if (Object.keys(updatePayload).length > 0) {
    await (supabase as any).from('invoices').update(updatePayload).eq('id', invoiceId);
  }

  // 8. Replace line items
  await (supabase as any).from('invoice_lines').delete().eq('invoice_id', invoiceId);

  if (finalLines.length > 0) {
    const llmByLine = new Map<number, MappedDocument['line_items'][number]>();
    if (llm) for (const li of llm.line_items) llmByLine.set(li.line_number, li);

    const lineRows = finalLines.map((item: any, idx: number) => {
      const llmLine = llmByLine.get(item.lineNumber ?? item.line_number) ?? llmByLine.get(idx + 1);
      const skuCode = item.skuRaw ?? item.sku_code ?? null;
      const desc    = item.description ?? null;
      const derivedSkuName = llmLine?.sku_name
        ?? (skuCode && desc ? `${skuCode} ${desc}`.trim() : desc ?? skuCode ?? null);
      return {
        invoice_id:   invoiceId,
        line_number:  item.lineNumber ?? item.line_number ?? idx + 1,
        description:  desc,
        sku_code:     skuCode,
        sku_name:     derivedSkuName,
        unit_of_measure: llmLine?.unit_of_measure ?? null,
        quantity:     item.quantity ?? null,
        unit_price:   item.unitPrice ?? item.unit_price ?? null,
        line_total:   item.lineTotal ?? item.line_total ?? null,
        field_confidences: llmLine ? { _llm_used: true } : {},
      };
    });

    await (supabase as any).from('invoice_lines').insert(lineRows);
  }

  return NextResponse.json({
    ok: true,
    invoiceId,
    fieldsUpdated: Object.keys(updatePayload),
    linesInserted: finalLines.length,
    source: useRegex ? 'regex' : llm ? 'llm_text' : 'none',
    invoiceNumber: updatePayload.invoice_number ?? null,
  });
}
