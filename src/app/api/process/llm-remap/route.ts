import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  mapDocumentWithLlm,
  mapDocumentImageWithLlm,
  isLlmMapperAvailable,
  isVisionMimeSupported,
  EMPTY_LLM_DOC,
  type MappedDocument,
} from '@/lib/processing/llm-mapper';
import { runValidation } from '@/lib/validation/engine';

// Vercel: must complete within 60s on Pro plan.
export const maxDuration = 60;

/**
 * POST /api/process/llm-remap
 *
 * Body: { document_id: string, force?: boolean }
 *
 * Re-runs invoice/order field & line-item mapping on a document using the
 * Gemini LLM. Use this when the regex-based extractor mis-mapped columns
 * (e.g. SKU code ended up in the description column because the vendor PDF
 * used "Product Code" as a header).
 *
 * Behaviour:
 *  - By default, only runs if the document is currently in `exception` status
 *    OR has zero invoice_lines / order_lines rows. Pass `force: true` to run
 *    on any document.
 *  - Replaces the existing invoice + invoice_lines (or order + order_lines)
 *    rows with the LLM's output.
 *  - Re-runs the validation engine afterwards.
 *
 * Designed to be called from the n8n `03-document-processor` workflow as a
 * follow-up node when the primary `/api/process` step leaves the document
 * in an exception state.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const documentId: string | undefined = body.document_id;
    const force: boolean = body.force === true;

    if (!documentId) {
      return NextResponse.json({ error: 'document_id required' }, { status: 400 });
    }

    if (!isLlmMapperAvailable()) {
      return NextResponse.json(
        { error: 'LLM mapper not configured (set OPENROUTER_API_KEY in .env)' },
        { status: 503 }
      );
    }

    const supabase = createServiceRoleClient();
    const admin = createAdminClient();

    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .select('id, status, document_type, ocr_raw_text, file_url, file_mime_type, original_filename')
      .eq('id', documentId)
      .single();

    if (docErr || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    if (!doc.ocr_raw_text || (doc.ocr_raw_text as string).trim().length < 10) {
      return NextResponse.json(
        { error: 'Document has no usable OCR text — run /api/process first' },
        { status: 400 }
      );
    }

    const docType = (doc.document_type as 'invoice' | 'order' | 'receipt' | null) ?? 'invoice';
    if (docType !== 'invoice' && docType !== 'order' && docType !== 'receipt') {
      return NextResponse.json(
        { error: `LLM remap supports invoice/order/receipt, got: ${docType}` },
        { status: 400 }
      );
    }

    // Eligibility check (skipped if force=true)
    if (!force) {
      if (docType === 'invoice' || docType === 'receipt') {
        const { data: existingInv } = await supabase
          .from('invoices')
          .select('id, invoice_lines(id)')
          .eq('document_id', documentId)
          .maybeSingle();

        const hasLines =
          existingInv &&
          Array.isArray((existingInv as any).invoice_lines) &&
          (existingInv as any).invoice_lines.length > 0;

        if (doc.status !== 'exception' && hasLines) {
          return NextResponse.json({
            skipped: true,
            reason: 'Document already has line items and is not in exception status. Pass force=true to override.',
          });
        }
      } else {
        const { data: existingOrd } = await supabase
          .from('orders')
          .select('id, order_lines(id)')
          .eq('document_id', documentId)
          .maybeSingle();

        const hasLines =
          existingOrd &&
          Array.isArray((existingOrd as any).order_lines) &&
          (existingOrd as any).order_lines.length > 0;

        if (doc.status !== 'exception' && hasLines) {
          return NextResponse.json({
            skipped: true,
            reason: 'Document already has line items and is not in exception status. Pass force=true to override.',
          });
        }
      }
    }

    // ── Vision-model enrichment for image documents ──────────────────────
    // Mirror the pipeline.ts logic: run vision-capable LLM on the raw image
    // AND the text-only LLM on OCR text, then merge (vision wins per field,
    // text fills any nulls vision missed).
    const mimeType: string = (doc as any).file_mime_type ?? '';
    const fileUrl: string = (doc as any).file_url ?? '';
    const originalFilename: string = (doc as any).original_filename ?? '';

    let visionMapped: MappedDocument | null = null;
    if (isVisionMimeSupported(mimeType) && fileUrl) {
      try {
        // Download the image from storage
        const { data: fileData } = await supabase.storage
          .from('original-documents')
          .download(fileUrl);
        if (fileData) {
          const rawBuffer = Buffer.from(await fileData.arrayBuffer());
          visionMapped = await mapDocumentImageWithLlm(
            rawBuffer,
            mimeType,
            doc.ocr_raw_text as string,
            docType
          );
        }
      } catch (err) {
        console.warn('[llm-remap] vision extraction failed, falling back to text only:', err);
      }
    }

    // Always run text-only LLM as backstop / field filler
    const textMapped = await mapDocumentWithLlm(doc.ocr_raw_text as string, docType);

    if (!visionMapped && !textMapped) {
      return NextResponse.json(
        { error: 'LLM mapping failed — see server logs' },
        { status: 502 }
      );
    }

    // Merge: vision wins per field, text fills nulls
    const pick = <K extends keyof MappedDocument>(key: K): MappedDocument[K] | null => {
      const v = visionMapped?.[key];
      if (v !== null && v !== undefined && v !== '') return v as MappedDocument[K];
      const t = textMapped?.[key];
      return (t ?? null) as MappedDocument[K] | null;
    };
    const visionLines = visionMapped?.line_items?.length ?? 0;
    const textLines  = textMapped?.line_items?.length ?? 0;
    const mergedLineItems: MappedDocument['line_items'] =
      (visionLines >= textLines ? visionMapped?.line_items : textMapped?.line_items) ?? [];

    // Filename stem filter: drop items that match the document filename
    const fnameNorm = originalFilename
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const filteredLineItems = fnameNorm.length > 5
      ? mergedLineItems.filter((li) => {
          const descNorm = (li.description || '').toLowerCase().replace(/\s+/g, ' ').trim();
          const nameNorm = (li.sku_name || '').toLowerCase().replace(/\s+/g, ' ').trim();
          if (descNorm && (fnameNorm.includes(descNorm) || descNorm.includes(fnameNorm))) return false;
          if (nameNorm && (fnameNorm.includes(nameNorm) || nameNorm.includes(fnameNorm))) return false;
          return true;
        })
      : mergedLineItems;

    const mapped: MappedDocument = {
      ...EMPTY_LLM_DOC,
      invoice_number:    pick('invoice_number') as string | null,
      order_number:      pick('order_number')   as string | null,
      invoice_date:      pick('invoice_date')   as string | null,
      order_date:        pick('order_date')     as string | null,
      due_date:          pick('due_date')       as string | null,
      delivery_date:     pick('delivery_date')  as string | null,
      vendor_name:       pick('vendor_name')    as string | null,
      vendor_code:       pick('vendor_code')    as string | null,
      vendor_address:    pick('vendor_address') as string | null,
      vendor_email:      pick('vendor_email')   as string | null,
      vendor_phone:      pick('vendor_phone')   as string | null,
      vendor_gstin:      pick('vendor_gstin')   as string | null,
      bill_to_name:      pick('bill_to_name')   as string | null,
      bill_to_address:   pick('bill_to_address') as string | null,
      customer_name:     pick('customer_name')  as string | null,
      customer_code:     pick('customer_code')  as string | null,
      customer_email:    pick('customer_email') as string | null,
      customer_phone:    pick('customer_phone') as string | null,
      shipping_address:  pick('shipping_address') as string | null,
      payment_terms:     pick('payment_terms')  as string | null,
      subtotal:          pick('subtotal')       as number | null,
      tax_amount:        pick('tax_amount')     as number | null,
      total_amount:      pick('total_amount')   as number | null,
      line_items:        filteredLineItems,
      confidence:        Math.max(visionMapped?.confidence ?? 0, textMapped?.confidence ?? 0),
      notes:             [visionMapped?.notes, textMapped?.notes].filter(Boolean).join(' | ') || null,
    };

    // Persist
    if (docType === 'invoice' || docType === 'receipt') {
      // Find or create the invoice row
      const { data: existing } = await supabase
        .from('invoices')
        .select('id')
        .eq('document_id', documentId)
        .maybeSingle();

      let invoiceId: string;
      const invoicePayload = {
        document_id: documentId,
        invoice_number: mapped.invoice_number,
        invoice_date: mapped.invoice_date,
        due_date: mapped.due_date,
        vendor_name: mapped.vendor_name,
        vendor_code: mapped.vendor_code,
        vendor_address: mapped.vendor_address,
        vendor_email: mapped.vendor_email,
        vendor_phone: mapped.vendor_phone,
        vendor_gstin: mapped.vendor_gstin,
        bill_to_name: mapped.bill_to_name,
        bill_to_address: mapped.bill_to_address,
        subtotal: mapped.subtotal,
        tax_amount: mapped.tax_amount,
        total_amount: mapped.total_amount,
        payment_terms: mapped.payment_terms,
        field_confidences: { _llm_confidence: mapped.confidence, _llm_notes: mapped.notes },
      };

      if (existing) {
        invoiceId = (existing as any).id;
        await supabase.from('invoices').update(invoicePayload as any).eq('id', invoiceId);
        // Replace line items
        await supabase.from('invoice_lines').delete().eq('invoice_id', invoiceId);
      } else {
        const { data: created, error: createErr } = await supabase
          .from('invoices')
          .insert(invoicePayload as any)
          .select('id')
          .single();
        if (createErr || !created) {
          return NextResponse.json(
            { error: `Failed to create invoice: ${createErr?.message}` },
            { status: 500 }
          );
        }
        invoiceId = (created as any).id;
      }

      if (mapped.line_items.length > 0) {
        await supabase.from('invoice_lines').insert(
          mapped.line_items.map((li) => ({
            invoice_id: invoiceId,
            line_number: li.line_number,
            description: li.description,
            sku_code: li.sku_code,
            sku_name: li.sku_name,
            unit_of_measure: li.unit_of_measure,
            quantity: li.quantity,
            unit_price: li.unit_price,
            line_total: li.line_total,
            field_confidences: { _llm_confidence: mapped.confidence },
          })) as any
        );
      }
    } else {
      // Order branch
      const { data: existing } = await supabase
        .from('orders')
        .select('id')
        .eq('document_id', documentId)
        .maybeSingle();

      let orderId: string;
      const orderPayload = {
        document_id: documentId,
        order_number: mapped.order_number ?? mapped.invoice_number,
        order_date: mapped.order_date ?? mapped.invoice_date,
        delivery_date: mapped.delivery_date,
        customer_name: mapped.customer_name ?? mapped.bill_to_name,
        customer_code: mapped.customer_code,
        customer_email: mapped.customer_email,
        customer_phone: mapped.customer_phone,
        shipping_address: mapped.shipping_address ?? mapped.bill_to_address,
        total_amount: mapped.total_amount,
        field_confidences: { _llm_confidence: mapped.confidence, _llm_notes: mapped.notes },
      };

      if (existing) {
        orderId = (existing as any).id;
        await supabase.from('orders').update(orderPayload as any).eq('id', orderId);
        await supabase.from('order_lines').delete().eq('order_id', orderId);
      } else {
        const { data: created, error: createErr } = await supabase
          .from('orders')
          .insert(orderPayload as any)
          .select('id')
          .single();
        if (createErr || !created) {
          return NextResponse.json(
            { error: `Failed to create order: ${createErr?.message}` },
            { status: 500 }
          );
        }
        orderId = (created as any).id;
      }

      if (mapped.line_items.length > 0) {
        await supabase.from('order_lines').insert(
          mapped.line_items.map((li) => ({
            order_id: orderId,
            line_number: li.line_number,
            description: li.description,
            sku_code: li.sku_code,
            sku_name: li.sku_name,
            unit_of_measure: li.unit_of_measure,
            quantity: li.quantity,
            unit_price: li.unit_price,
            line_total: li.line_total,
            field_confidences: { _llm_confidence: mapped.confidence },
          })) as any
        );
      }
    }

    // Re-run validation
    const validation = await runValidation(admin, documentId, docType);

    // Clear exception status if we now have data
    const newStatus = validation.allPassed
      ? 'validated'
      : mapped.line_items.length > 0
        ? 'extracted'
        : 'exception';

    await supabase
      .from('documents')
      .update({
        status: newStatus,
        error_message: newStatus === 'exception' ? 'LLM remap produced no line items' : null,
      } as any)
      .eq('id', documentId);

    await supabase.from('processing_logs' as any).insert({
      document_id: documentId,
      step_name: 'llm_remap',
      status: 'completed',
      step_details: {
        line_items_mapped: mapped.line_items.length,
        confidence: mapped.confidence,
        notes: mapped.notes,
      },
    } as any);

    return NextResponse.json({
      status: 'completed',
      document_id: documentId,
      new_status: newStatus,
      line_items_mapped: mapped.line_items.length,
      confidence: mapped.confidence,
      notes: mapped.notes,
      validation: {
        all_passed: validation.allPassed,
        total_checks: validation.totalChecks,
        errors: validation.totalErrors,
        warnings: validation.totalWarnings,
      },
    });
  } catch (err: unknown) {
    console.error('[llm-remap] error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
