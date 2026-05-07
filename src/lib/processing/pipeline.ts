import { createAdminClient } from '@/lib/supabase/admin';
import { performOcr, performOcrOnPdf } from '@/lib/ocr/google-vision';
import { preprocessImage } from '@/lib/processing/preprocessor';
import { classifyDocument } from '@/lib/processing/classifier';
import { extractInvoiceFields, extractOrderFields, extractFromFilename } from '@/lib/processing/extractor';
import { mapDocumentWithLlm, mapDocumentImageWithLlm, isLlmMapperAvailable, isVisionMimeSupported, EMPTY_LLM_DOC, type MappedDocument } from '@/lib/processing/llm-mapper';
import { runValidation } from '@/lib/validation/engine';
import { downloadFile, isOrdersFolderDoc } from '@/lib/gdrive/client';

function now() { return new Date().toISOString(); }

async function appendLog(
  supabase: ReturnType<typeof createAdminClient>,
  documentId: string,
  stage: string,
  status: 'started' | 'completed' | 'failed',
  details?: Record<string, unknown>
) {
  const { data: doc } = await supabase
    .from('documents')
    .select('processing_log')
    .eq('id', documentId)
    .single();

  const log = Array.isArray(doc?.processing_log) ? doc.processing_log : [];
  log.push({ stage, status, ts: now(), details } as any);

  await supabase
    .from('documents')
    .update({ processing_log: log } as any)
    .eq('id', documentId);
}

async function updateDoc(
  supabase: ReturnType<typeof createAdminClient>,
  documentId: string,
  updates: Record<string, unknown>
) {
  await supabase
    .from('documents')
    .update(updates as any)
    .eq('id', documentId);
}

/** Pick the first non-null/non-empty value from a list of candidates. */
function firstNonEmpty<T>(...values: (T | null | undefined)[]): T | null {
  for (const v of values) {
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function normalizeForMaster(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

type ItemMasterLike = {
  sku_code: string | null;
  upc: string | null;
  description: string | null;
  unit_price: number | null;
};

function buildItemMasterIndex(items: ItemMasterLike[]) {
  const bySku = new Map<string, ItemMasterLike>();
  const byUpc = new Map<string, ItemMasterLike>();
  const byName = new Map<string, ItemMasterLike>();
  for (const it of items) {
    if (it.sku_code) bySku.set(it.sku_code.toLowerCase(), it);
    if (it.upc) byUpc.set(it.upc.toLowerCase(), it);
    const n = normalizeForMaster(it.description);
    if (n) byName.set(n, it);
  }
  return { bySku, byUpc, byName, all: items };
}

function matchLineToMaster(
  line: { sku_code?: string | null; sku_name?: string | null; description?: string | null },
  index: ReturnType<typeof buildItemMasterIndex>
): ItemMasterLike | null {
  const sku = (line.sku_code || '').trim().toLowerCase();
  if (sku) {
    const hit = index.bySku.get(sku) || index.byUpc.get(sku);
    if (hit) return hit;
  }

  const name = normalizeForMaster(line.sku_name || line.description);
  if (!name) return null;

  const exact = index.byName.get(name);
  if (exact) return exact;

  const tokens = new Set(name.split(' ').filter((t) => t.length > 2));
  if (tokens.size === 0) return null;

  let best: { item: ItemMasterLike; score: number } | null = null;
  for (const it of index.all) {
    const n = normalizeForMaster(it.description);
    if (!n) continue;
    const its = new Set(n.split(' ').filter((t) => t.length > 2));
    if (its.size === 0) continue;
    let overlap = 0;
    tokens.forEach((t) => {
      if (its.has(t)) overlap++;
    });
    const score = overlap / Math.max(tokens.size, its.size);
    if (score >= 0.6 && (!best || score > best.score)) {
      best = { item: it, score };
    }
  }
  return best?.item ?? null;
}

/**
 * Reject strings that are clearly not a real order/invoice number — short
 * alphabetic fragments ("se", "tato"), header words ("ITEMS", "TOTAL"), or
 * ID-shaped values without any digits. Used to scrub the regex extractor's
 * output before falling back to filename-derived numbers.
 */
function scrubRefNumberValue(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = String(v).trim();
  if (!t) return null;
  if (/^[a-zA-Z]{1,5}$/.test(t)) return null;
  if (/^(items?|total|qty|date|order|po|amount|price|subtotal|tax|note|name)$/i.test(t)) return null;
  if (t.length < 3) return null;
  if (!/\d/.test(t)) return null;
  return t;
}

/**
 * Run the LLM mapper on the OCR text. Wrapped in try/catch so a failure here
 * never breaks the main pipeline — the regex extractor's output is always
 * the safe fallback.
 *
 * Set `LLM_ENRICHMENT_ENABLED=false` to skip entirely (useful for local dev
 * without a key, or if costs need to be capped).
 */
async function runLlmEnrichment(
  ocrText: string,
  documentType: 'invoice' | 'order' | 'receipt',
  supabase: ReturnType<typeof createAdminClient>,
  documentId: string
): Promise<MappedDocument | null> {
  if (process.env.LLM_ENRICHMENT_ENABLED === 'false') return null;
  if (!isLlmMapperAvailable()) return null;

  await appendLog(supabase, documentId, 'llm_enrichment', 'started');
  try {
    const mapped = await mapDocumentWithLlm(ocrText, documentType);
    await appendLog(supabase, documentId, 'llm_enrichment', 'completed', {
      success: !!mapped,
      lineItems: mapped?.line_items.length ?? 0,
      confidence: mapped?.confidence ?? null,
      notes: mapped?.notes ?? null,
    });
    return mapped;
  } catch (err) {
    console.error('[pipeline] LLM enrichment failed:', err);
    await appendLog(supabase, documentId, 'llm_enrichment', 'failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function processDocument(documentId: string): Promise<void> {
  const supabase = createAdminClient();
  const startTime = Date.now();

  try {
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .single();

    if (docError || !doc) throw new Error(`Document not found: ${documentId}`);

    // Clean up old records if re-processing (e.g. exception docs)
    await supabase.from('invoice_lines').delete().in(
      'invoice_id',
      (await supabase.from('invoices').select('id').eq('document_id', documentId)).data?.map(i => i.id) ?? []
    );
    await supabase.from('invoices').delete().eq('document_id', documentId);
    await supabase.from('order_lines').delete().in(
      'order_id',
      (await supabase.from('orders').select('id').eq('document_id', documentId)).data?.map(o => o.id) ?? []
    );
    await supabase.from('orders').delete().eq('document_id', documentId);

    // ============ STEP 1: PREPROCESSING ============
    await updateDoc(supabase, documentId, { status: 'processing' });
    await appendLog(supabase, documentId, 'preprocessing', 'started');

    let rawBuffer: Buffer;
    let mimeType: string = doc.file_mime_type ?? 'image/jpeg';

    // Handle Google Drive source: download from GDrive, upload to storage
    const isGdrive = (doc as any).source === 'google_drive';
    const fileUrl = doc.file_url as string;
    const isExternalUrl = fileUrl?.startsWith('http://') || fileUrl?.startsWith('https://');

    if (isGdrive && (doc as any).source_identifier && isExternalUrl) {
      // File is still on Google Drive (not yet in Supabase storage) — download it
      const gdriveFileId = (doc as any).source_identifier as string;
      const downloaded = await downloadFile(gdriveFileId);
      rawBuffer = downloaded.buffer;
      mimeType = downloaded.mimeType;

      // Upload to Supabase storage for future access
      const ext = ((doc as any).original_filename || '').split('.').pop() || 'jpg';
      const storagePath = `gdrive/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${gdriveFileId}.${ext}`;

      await supabase.storage
        .from('original-documents')
        .upload(storagePath, rawBuffer, { contentType: mimeType, upsert: true });

      // Update document to point to storage path
      await updateDoc(supabase, documentId, { file_url: storagePath, file_mime_type: mimeType });
    } else {
      // File is in Supabase storage — download normally
      const { data: fileData, error: fileError } = await supabase.storage
        .from('original-documents')
        .download(fileUrl);

      if (fileError || !fileData) throw new Error(`Cannot download file: ${fileError?.message}`);
      rawBuffer = Buffer.from(await fileData.arrayBuffer());
    }

    const isPdf = mimeType === 'application/pdf';

    let processedBuffer: Buffer;
    let processedMime: string;

    if (isPdf) {
      processedBuffer = rawBuffer;
      processedMime = 'application/pdf';
    } else {
      const preprocessed = await preprocessImage(rawBuffer, mimeType);
      processedBuffer = preprocessed.buffer;
      processedMime = preprocessed.mimeType;

      const preprocessedPath = `preprocessed/${documentId}.png`;
      await supabase.storage
        .from('preprocessed-documents')
        .upload(preprocessedPath, preprocessed.buffer, {
          contentType: preprocessed.mimeType,
          upsert: true,
        });

      await updateDoc(supabase, documentId, {
        preprocessed_file_url: preprocessedPath,
        preprocessing_ops: {
          rotated: preprocessed.metadata.wasRotated,
          deskewed: preprocessed.metadata.wasDeskewed,
          contrast: preprocessed.metadata.contrastEnhanced,
        },
      });
    }

    await appendLog(supabase, documentId, 'preprocessing', 'completed');

    // ============ STEP 2: OCR ============
    await appendLog(supabase, documentId, 'ocr', 'started');

    const ocrResult = isPdf
      ? await performOcrOnPdf(processedBuffer)
      : await performOcr(processedBuffer, processedMime);

    const wordCount = ocrResult.fullText.split(/\s+/).filter(Boolean).length;

    await updateDoc(supabase, documentId, {
      status: 'extracted',
      ocr_raw_text: ocrResult.fullText,
      ocr_confidence: ocrResult.averageConfidence,
      ocr_language: ocrResult.languageCode,
      ocr_word_count: wordCount,
      ocr_blocks: ocrResult.blocks as unknown,
    });

    await appendLog(supabase, documentId, 'ocr', 'completed', {
      confidence: ocrResult.averageConfidence,
      wordCount,
    });

    // ============ STEP 2.5: BLANK-DOCUMENT GATE ============
    // If the OCR produced essentially nothing (blank page, white scan, fax
    // header only, accidental upload) we don't want to call the LLM, run
    // regex extraction, or leave the document with NO row in the data table.
    //
    // Instead we insert a single invoice row whose fields are all NULL and
    // mark the document `blank` so reviewers see it sitting in the table
    // with every column blank — which is exactly what's on the page.
    const meaningfulText = ocrResult.fullText
      .replace(/[^A-Za-z0-9]/g, '') // drop punctuation, whitespace, symbols
      .trim();
    const isBlankDocument =
      ocrResult.fullText.trim().length < 20 || // almost nothing scanned
      meaningfulText.length < 8 ||              // no real words/numbers
      wordCount < 3;                            // fewer than 3 words

    if (isBlankDocument) {
      await appendLog(supabase, documentId, 'blank_detection', 'completed', {
        ocrLength: ocrResult.fullText.length,
        meaningfulChars: meaningfulText.length,
        wordCount,
        rawSnippet: ocrResult.fullText.slice(0, 60),
      });

      // Route the all-null placeholder row to the right table based on the
      // document's source. GDrive "orders" folder docs MUST land in `orders`
      // — otherwise they're invisible on /dashboard/orders → Google drive.
      const isOrdersFolder = isOrdersFolderDoc(doc as any);

      if (isOrdersFolder) {
        await supabase.from('orders').insert({
          document_id: documentId,
          order_number: null,
          order_date: null,
          customer_name: null,
          customer_code: null,
          customer_phone: null,
          customer_email: null,
          customer_whatsapp: null,
          shipping_address: null,
          total_amount: null,
          delivery_date: null,
          special_instructions: null,
          field_confidences: { _blank_document: true },
        } as any);
      } else {
        // Insert an all-null invoice row so the data table renders the
        // document with empty cells in every column.
        await supabase.from('invoices').insert({
          document_id: documentId,
          invoice_number: null,
          invoice_date: null,
          vendor_name: null,
          vendor_code: null,
          vendor_address: null,
          vendor_email: null,
          vendor_phone: null,
          vendor_gstin: null,
          bill_to_name: null,
          bill_to_address: null,
          subtotal: null,
          tax_amount: null,
          total_amount: null,
          payment_terms: null,
          due_date: null,
          field_confidences: { _blank_document: true },
          is_vendor_invoice: (doc as any).gdrive_folder_kind === 'vendor_invoices',
        } as any);
      }

      // Use 'extracted' status (already in the allowed enum) so the document
      // appears in the data table with empty cells. The blank state is
      // signalled via document_type='unknown'/'order', error_message, and the
      // _blank_document flag in field_confidences (no DB migration needed).
      await updateDoc(supabase, documentId, {
        status: 'extracted',
        document_type: isOrdersFolder ? 'order' : 'unknown',
        classification_confidence: 1.0,
        error_message: 'Blank document — OCR extracted no usable text',
      });

      const totalDuration = Date.now() - startTime;
      await appendLog(supabase, documentId, 'pipeline', 'completed', {
        result: 'blank_document',
        totalDurationMs: totalDuration,
      });
      return;
    }

    // ============ STEP 3: CLASSIFICATION ============
    await appendLog(supabase, documentId, 'classification', 'started');

    let classification = classifyDocument(ocrResult.fullText);

    // Filename-derived hints (date / vendor / number / type / customer).
    // Used to (a) pick a sensible classification when OCR is too noisy and
    // (b) fill in missing fields before the row is inserted so the table
    // column cells always show *something*.
    const filenameHints = extractFromFilename((doc as any).original_filename);

    if (
      (classification.documentType === 'unknown' || classification.documentType === 'unstructured') &&
      filenameHints.documentTypeHint
    ) {
      const mapped: 'invoice' | 'order' | 'receipt' =
        filenameHints.documentTypeHint === 'bill' ? 'invoice' : filenameHints.documentTypeHint;
      classification = {
        documentType: mapped,
        confidence: Math.max(classification.confidence, 0.45),
        signals: [...classification.signals, `filename_hint=${filenameHints.documentTypeHint}`],
      };
    }

    // Hard override: documents imported from the GDrive "orders" folder are
    // ALWAYS purchase orders from customers, regardless of what the
    // OCR-text-based classifier guessed. This makes the dashboard "New Orders
    // → Google Drive" tab reliable even when the order layout looks invoice-y.
    if (isOrdersFolderDoc(doc as any)) {
      classification = {
        documentType: 'order',
        confidence: 1.0,
        signals: [...classification.signals, 'gdrive_folder=orders'],
      };
    }

    await updateDoc(supabase, documentId, {
      document_type: classification.documentType,
      classification_confidence: classification.confidence,
    });

    await appendLog(supabase, documentId, 'classification', 'completed', {
      type: classification.documentType,
      confidence: classification.confidence,
      signals: classification.signals,
    });

    // ============ STEP 4: FIELD EXTRACTION ============
    await appendLog(supabase, documentId, 'extraction', 'started');

    if (classification.documentType === 'invoice' || classification.documentType === 'receipt') {
      const extracted = extractInvoiceFields(ocrResult.fullText);

      // ── Filename fallback ────────────────────────────────────────────────
      // When OCR / regex extraction missed key fields (low-quality image or
      // unfamiliar layout) lean on the filename so the data table still
      // shows Invoice #, Date and Vendor in their respective columns.
      if (!extracted.invoiceNumber && filenameHints.invoiceNumber) {
        extracted.invoiceNumber = filenameHints.invoiceNumber;
        extracted.fieldConfidences.invoice_number = 0.5;
      }
      if (!extracted.invoiceDate && filenameHints.invoiceDate) {
        extracted.invoiceDate = filenameHints.invoiceDate;
        extracted.fieldConfidences.invoice_date = 0.5;
      }
      if (!extracted.vendorName && filenameHints.vendorName) {
        extracted.vendorName = filenameHints.vendorName;
        extracted.fieldConfidences.vendor_name = 0.4;
      }
      if (!extracted.billToName && filenameHints.customerName) {
        extracted.billToName = filenameHints.customerName;
        extracted.fieldConfidences.bill_to_name = 0.4;
      }

      // ── LLM enrichment (handles non-standard column headers) ─────────────
      // Runs on every invoice regardless of source (email/WhatsApp/GDrive/silo)
      // and fills in any field the regex extractor couldn't reliably parse.
      // For image-based invoices we ALSO run a vision-LLM that sees the
      // image directly (much better on photos / handwritten / multi-column
      // layouts).
      let llmInvVision: MappedDocument | null = null;
      const invVisionEligible =
        isVisionMimeSupported(mimeType) &&
        rawBuffer &&
        process.env.LLM_ENRICHMENT_ENABLED !== 'false' &&
        isLlmMapperAvailable();
      if (invVisionEligible) {
        await appendLog(supabase, documentId, 'llm_vision', 'started');
        try {
          llmInvVision = await mapDocumentImageWithLlm(rawBuffer, mimeType, ocrResult.fullText, 'invoice');
          await appendLog(supabase, documentId, 'llm_vision', 'completed', {
            success: !!llmInvVision,
            lineItems: llmInvVision?.line_items.length ?? 0,
            confidence: llmInvVision?.confidence ?? null,
            notes: llmInvVision?.notes ?? null,
          });
        } catch (err) {
          await appendLog(supabase, documentId, 'llm_vision', 'failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          llmInvVision = null;
        }
      }

      const llmText = await runLlmEnrichment(
        ocrResult.fullText,
        classification.documentType,
        supabase,
        documentId
      );

      // Vision wins per field; text fills nulls.
      const pickInv = <K extends keyof MappedDocument>(key: K): MappedDocument[K] | null => {
        const v = llmInvVision?.[key];
        if (v !== null && v !== undefined && v !== '') return v as MappedDocument[K];
        const t = llmText?.[key];
        return (t ?? null) as MappedDocument[K] | null;
      };
      const visionInvLines = llmInvVision?.line_items?.length ?? 0;
      const textInvLines = llmText?.line_items?.length ?? 0;
      const llmInvLineItems: MappedDocument['line_items'] =
        (visionInvLines >= textInvLines ? llmInvVision?.line_items : llmText?.line_items) ?? [];
      const llm: MappedDocument | null = (llmInvVision || llmText)
        ? {
            ...EMPTY_LLM_DOC,
            invoice_number: pickInv('invoice_number') as string | null,
            invoice_date: pickInv('invoice_date') as string | null,
            due_date: pickInv('due_date') as string | null,
            vendor_name: pickInv('vendor_name') as string | null,
            vendor_code: pickInv('vendor_code') as string | null,
            bill_to_name: pickInv('bill_to_name') as string | null,
            bill_to_address: pickInv('bill_to_address') as string | null,
            shipping_address: pickInv('shipping_address') as string | null,
            payment_terms: pickInv('payment_terms') as string | null,
            subtotal: pickInv('subtotal') as number | null,
            tax_amount: pickInv('tax_amount') as number | null,
            total_amount: pickInv('total_amount') as number | null,
            line_items: llmInvLineItems,
            confidence: Math.max(llmInvVision?.confidence ?? 0, llmText?.confidence ?? 0),
            notes: [llmInvVision?.notes, llmText?.notes].filter(Boolean).join(' | ') || null,
          }
        : null;

      // Merge: regex first, LLM fills nulls. LLM line items take precedence
      // when regex returned nothing (most common failure mode).
      const finalInvoiceNumber = firstNonEmpty<string>(
        scrubRefNumberValue(extracted.invoiceNumber),
        scrubRefNumberValue(llm?.invoice_number ?? null)
      );
      const finalInvoiceDate = firstNonEmpty<string>(extracted.invoiceDate, llm?.invoice_date);
      const finalDueDate = firstNonEmpty<string>(extracted.dueDate, llm?.due_date);
      const finalVendorName = firstNonEmpty<string>(extracted.vendorName, llm?.vendor_name);
      const finalVendorCode = firstNonEmpty<string>(extracted.vendorCode, llm?.vendor_code);
      const finalBillToName = firstNonEmpty<string>(extracted.billToName, llm?.bill_to_name);
      const finalBillToAddress = firstNonEmpty<string>(extracted.billToAddress, llm?.bill_to_address);
      const finalSubtotal = firstNonEmpty<number>(extracted.subtotal, llm?.subtotal);
      const finalTax = firstNonEmpty<number>(extracted.taxAmount, llm?.tax_amount);
      const finalTotal = firstNonEmpty<number>(extracted.totalAmount, llm?.total_amount);
      const finalTerms = firstNonEmpty<string>(extracted.paymentTerms, llm?.payment_terms);

      const fieldConfidences: Record<string, unknown> = { ...extracted.fieldConfidences };
      if (llm) {
        fieldConfidences._llm_used = true;
        fieldConfidences._llm_confidence = llm.confidence;
        fieldConfidences._llm_notes = llm.notes;
      }

      // Choose final line items: prefer regex if it found any, else use LLM
      const useLlmLines = extracted.lineItems.length === 0 && (llm?.line_items?.length ?? 0) > 0;
      const finalLineItems = useLlmLines
        ? (llm!.line_items.map((li) => ({
            lineNumber: li.line_number,
            description: li.description,
            skuRaw: li.sku_code,
            quantity: li.quantity,
            unitPrice: li.unit_price,
            lineTotal: li.line_total,
          })))
        : extracted.lineItems;

      // Was anything recognised at all (after filename + LLM fallback)?
      const recognisedAnything =
        finalVendorName ||
        finalTotal != null ||
        finalInvoiceNumber ||
        (finalLineItems && finalLineItems.length > 0);

      const isVendorInvoice = (doc as any).gdrive_folder_kind === 'vendor_invoices';

      const sanitiseInvDate = (raw: string | null | undefined): string | null => {
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
      };

      const invoicePayload = {
        invoice_number: finalInvoiceNumber,
        invoice_date: sanitiseInvDate(finalInvoiceDate),
        vendor_name: finalVendorName,
        vendor_code: finalVendorCode,
        vendor_address: llm?.vendor_address ?? null,
        vendor_email: llm?.vendor_email ?? null,
        vendor_phone: llm?.vendor_phone ?? null,
        vendor_gstin: llm?.vendor_gstin ?? null,
        bill_to_name: finalBillToName,
        bill_to_address: finalBillToAddress,
        subtotal: finalSubtotal,
        tax_amount: finalTax,
        total_amount: finalTotal,
        payment_terms: finalTerms,
        due_date: sanitiseInvDate(finalDueDate),
        field_confidences: fieldConfidences,
        is_vendor_invoice: isVendorInvoice,
      } as any;

      // Upsert: if a record already exists for this document (re-processing), update it.
      const { data: existingInv } = await (supabase as any)
        .from('invoices')
        .select('id')
        .eq('document_id', documentId)
        .maybeSingle();

      let invoiceId: string | null = null;
      let invInsertError: any = null;

      if (existingInv?.id) {
        const { error: updateErr } = await (supabase as any)
          .from('invoices')
          .update(invoicePayload)
          .eq('id', existingInv.id);
        invInsertError = updateErr;
        if (!updateErr) {
          // Clear old lines so we can re-insert fresh ones below
          await (supabase as any).from('invoice_lines').delete().eq('invoice_id', existingInv.id);
          invoiceId = existingInv.id;
        }
      } else {
        const { data: newInv, error: insertErr } = await (supabase as any)
          .from('invoices')
          .insert({ document_id: documentId, ...invoicePayload })
          .select('id')
          .single();
        invInsertError = insertErr;
        invoiceId = newInv?.id ?? null;
      }

      if (invInsertError) {
        console.error('[pipeline] invoice upsert failed:', invInsertError);
        await appendLog(supabase, documentId, 'extraction', 'failed', {
          stage: 'invoice_insert',
          error: invInsertError.message,
        });
      }

      if (invoiceId && finalLineItems.length > 0) {
        // Build a quick lookup of LLM sku_name / unit_of_measure when we used
        // the regex output as the base.
        const llmByLine = new Map<number, MappedDocument['line_items'][number]>();
        if (llm) {
          for (const li of llm.line_items) llmByLine.set(li.line_number, li);
        }

        await supabase.from('invoice_lines').insert(
          finalLineItems.map((item, idx) => {
            const llmLine = llmByLine.get(item.lineNumber) ?? llmByLine.get(idx + 1);
            // Derive sku_name: prefer LLM value, else combine code + description
            const derivedSkuName = llmLine?.sku_name
              ?? (item.skuRaw && item.description
                ? `${item.skuRaw} ${item.description}`.trim()
                : item.description ?? item.skuRaw ?? null);
            return {
              invoice_id: invoiceId,
              line_number: item.lineNumber,
              description: item.description,
              sku_code: item.skuRaw,
              sku_name: derivedSkuName,
              unit_of_measure: llmLine?.unit_of_measure ?? null,
              quantity: item.quantity,
              unit_price: item.unitPrice,
              line_total: item.lineTotal,
              field_confidences: llmLine ? { _llm_used: true } : {},
            };
          }) as any
        );
      }

      // If essential fields are still missing, mark for manual review so the
      // operator sees this row in the Exceptions tab.
      if (!recognisedAnything) {
        await updateDoc(supabase, documentId, {
          status: 'exception',
          error_message: 'Unrecognised invoice format \u2014 partial data filled from filename, please review',
        });
        await appendLog(supabase, documentId, 'extraction', 'completed', {
          recognised: false,
          fallback: 'filename',
        });
        const elapsed = Date.now() - startTime;
        await updateDoc(supabase, documentId, {
          total_processing_time_ms: elapsed,
          processed_at: now(),
        });
        await appendLog(supabase, documentId, 'complete', 'completed', { totalMs: elapsed });
        return;
      }
    } else if (classification.documentType === 'order') {
      const extracted = extractOrderFields(ocrResult.fullText);

      // ── Image-quality gate for WhatsApp image orders ──────────────────────
      // If the source is a WhatsApp image attachment and OCR produced too
      // little usable text, or no line items were extracted, mark the document
      // as an exception rather than creating a malformed, empty order record.
      const isWhatsAppImage =
        (doc as any).source === 'whatsapp' &&
        typeof (doc as any).file_mime_type === 'string' &&
        (doc as any).file_mime_type.startsWith('image/');

      const MIN_WORD_COUNT = 5;       // fewer words → image too blurry / unreadable
      const MIN_OCR_CONFIDENCE = 0.25; // below 25 % → OCR result unreliable

      if (isWhatsAppImage) {
        const poorOcr =
          wordCount < MIN_WORD_COUNT ||
          (ocrResult.averageConfidence > 0 && ocrResult.averageConfidence < MIN_OCR_CONFIDENCE);

        const noItems = extracted.lineItems.length === 0;

        if (poorOcr || noItems) {
          const reason = poorOcr
            ? `OCR quality too low (words: ${wordCount}, confidence: ${(ocrResult.averageConfidence * 100).toFixed(1)}%) — image may be blurry or unreadable`
            : 'No valid order line items could be extracted from the image';

          await updateDoc(supabase, documentId, {
            status: 'exception',
            exception_status: 'pending',
            exception_reason: reason,
            document_type: 'order',
          });

          await appendLog(supabase, documentId, 'extraction', 'completed', {
            skipped: true,
            reason,
          });

          // Skip the rest of the order-insert block
          await appendLog(supabase, documentId, 'validation', 'completed', {
            passed: false,
            skipped: true,
          });

          const elapsed = Date.now() - startTime;
          await updateDoc(supabase, documentId, {
            total_processing_time_ms: elapsed,
            processed_at: now(),
          });
          await appendLog(supabase, documentId, 'complete', 'completed', { totalMs: elapsed, reason });
          return;
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      // WhatsApp sender → customer mapping via match_customer() DB function
      let customerPhone: string | null = null;
      let customerWhatsApp: string | null = null;
      let resolvedCustomerName = extracted.customerName;
      let resolvedCustomerCode = extracted.customerCode;

      if ((doc as any).source === 'whatsapp' && (doc as any).whatsapp_sender) {
        customerPhone = (doc as any).whatsapp_sender;
        customerWhatsApp = (doc as any).whatsapp_sender;

        // Try to resolve customer from phone number using master_customers
        const { data: matched } = await supabase
          .from('master_customers' as any)
          .select('customer_name, customer_code')
          .or(`phone.eq.${customerPhone},whatsapp_number.eq.${customerPhone}`)
          .eq('is_active', true)
          .limit(1);

        if (matched && matched.length > 0) {
          const best = matched[0] as any;
          resolvedCustomerName = best.customer_name || resolvedCustomerName;
          resolvedCustomerCode = best.customer_code || resolvedCustomerCode;
        }
      }

      // ── LLM enrichment for orders ────────────────────────────────────────
      // For image-based orders (handwritten WhatsApp / Drive photos) prefer
      // the vision-capable LLM that SEES the image directly. Falls back to
      // text-only LLM on failure / non-image documents.
      let llmOrder: MappedDocument | null = null;
      const visionEligible =
        isVisionMimeSupported(mimeType) &&
        rawBuffer &&
        process.env.LLM_ENRICHMENT_ENABLED !== 'false' &&
        isLlmMapperAvailable();

      if (visionEligible) {
        await appendLog(supabase, documentId, 'llm_vision', 'started');
        try {
          llmOrder = await mapDocumentImageWithLlm(rawBuffer, mimeType, ocrResult.fullText, 'order');
          await appendLog(supabase, documentId, 'llm_vision', 'completed', {
            success: !!llmOrder,
            lineItems: llmOrder?.line_items.length ?? 0,
            confidence: llmOrder?.confidence ?? null,
            notes: llmOrder?.notes ?? null,
          });
        } catch (err) {
          await appendLog(supabase, documentId, 'llm_vision', 'failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          llmOrder = null;
        }
      }

      // Always run the text-only enrichment too — it serves as a backstop
      // when vision returns nothing OR populates fields the vision model
      // missed (we merge with vision-first preference below).
      const llmOrderText = await runLlmEnrichment(
        ocrResult.fullText,
        'order',
        supabase,
        documentId
      );

      // Pick a winner per field: vision wins, text fills any nulls vision missed.
      const pickLlm = <K extends keyof MappedDocument>(key: K): MappedDocument[K] | null => {
        const v = llmOrder?.[key];
        if (v !== null && v !== undefined && v !== '') return v as MappedDocument[K];
        const t = llmOrderText?.[key];
        return (t ?? null) as MappedDocument[K] | null;
      };

      // Pick line_items from whichever model returned more (vision wins on tie).
      const visionLines = llmOrder?.line_items?.length ?? 0;
      const textLines = llmOrderText?.line_items?.length ?? 0;
      const llmLineItems: MappedDocument['line_items'] =
        (visionLines >= textLines ? llmOrder?.line_items : llmOrderText?.line_items) ?? [];

      const llmCombined: MappedDocument | null = (llmOrder || llmOrderText)
        ? {
            ...EMPTY_LLM_DOC,
            order_number: pickLlm('order_number') as string | null,
            order_date: pickLlm('order_date') as string | null,
            delivery_date: pickLlm('delivery_date') as string | null,
            customer_name: pickLlm('customer_name') as string | null,
            customer_code: pickLlm('customer_code') as string | null,
            customer_phone: pickLlm('customer_phone') as string | null,
            customer_email: pickLlm('customer_email') as string | null,
            shipping_address: pickLlm('shipping_address') as string | null,
            payment_terms: pickLlm('payment_terms') as string | null,
            total_amount: pickLlm('total_amount') as number | null,
            subtotal: pickLlm('subtotal') as number | null,
            tax_amount: pickLlm('tax_amount') as number | null,
            line_items: llmLineItems,
            confidence: Math.max(llmOrder?.confidence ?? 0, llmOrderText?.confidence ?? 0),
            notes: [llmOrder?.notes, llmOrderText?.notes].filter(Boolean).join(' | ') || null,
          }
        : null;

      const finalOrderNumber = firstNonEmpty<string>(
        scrubRefNumberValue(extracted.orderNumber),
        scrubRefNumberValue(llmCombined?.order_number ?? null)
      );
      const finalOrderDate = firstNonEmpty<string>(extracted.orderDate, llmCombined?.order_date);
      const finalDeliveryDate = firstNonEmpty<string>(extracted.deliveryDate, llmCombined?.delivery_date);
      const finalCustomerName = firstNonEmpty<string>(resolvedCustomerName, llmCombined?.customer_name);
      const finalCustomerCode = firstNonEmpty<string>(resolvedCustomerCode, llmCombined?.customer_code);
      const finalBillingAddress = firstNonEmpty<string>(llmCombined?.bill_to_address ?? null, llmCombined?.shipping_address ?? null);
      const finalShipTo = firstNonEmpty<string>(extracted.shipToAddress, llmCombined?.shipping_address);
      const finalOrderTotal = firstNonEmpty<number>(extracted.orderTotal, llmCombined?.total_amount);
      const finalSubtotal = firstNonEmpty<number>(llmCombined?.subtotal);
      const finalTaxAmount = firstNonEmpty<number>(llmCombined?.tax_amount);
      const finalPaymentTerms = firstNonEmpty<string>(llmCombined?.payment_terms);
      const finalSpecial = firstNonEmpty<string>(extracted.specialInstructions, llmCombined?.payment_terms);

      // ── Filename fallbacks for order metadata ────────────────────────────
      // Drive / WhatsApp photos often have NO printed order number and NO
      // printed date inside the page. Without these the row will fail
      // validation and get hidden behind an "exception" badge — the bug
      // the user is reporting. We use the filename's leading numeric
      // prefix and embedded YYYY-MM-DD as a deterministic fallback.
      const fname: string = (doc as any).original_filename || '';
      let derivedOrderNumber: string | null = null;
      let derivedOrderDate: string | null = null;
      // Prefix like "00007132-..." → "00007132" (preserve leading zeros)
      const numPrefix = fname.match(/^(\d{4,})\b/);
      if (numPrefix) derivedOrderNumber = numPrefix[1];
      // Embedded date "PHOTO-2026-04-23-22-02-08" → "2026-04-23"
      const dateMatch = fname.match(/(20\d{2})[-_/]?(\d{2})[-_/]?(\d{2})/);
      if (dateMatch) {
        derivedOrderDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
      }

      const finalOrderNumberWithFallback = finalOrderNumber || derivedOrderNumber;
      const finalOrderDateWithFallback = finalOrderDate
        || derivedOrderDate
        || (((doc as any).received_at as string | null)?.slice(0, 10) ?? null)
        || (((doc as any).created_at as string | null)?.slice(0, 10) ?? null);

      const orderConfidences: Record<string, unknown> = { ...extracted.fieldConfidences };
      if (llmCombined) {
        orderConfidences._llm_used = true;
        orderConfidences._llm_vision_used = !!llmOrder;
        orderConfidences._llm_text_used = !!llmOrderText;
        orderConfidences._llm_confidence = llmCombined.confidence;
        orderConfidences._llm_notes = llmCombined.notes;
      }
      if (derivedOrderNumber && !finalOrderNumber) {
        orderConfidences._order_number_from_filename = true;
      }
      if (derivedOrderDate && !finalOrderDate) {
        orderConfidences._order_date_from_filename = true;
      }

      // Prefer LLM-merged line items when the regex extractor returned
      // nothing OR when the LLM produced significantly more items (the
      // common case for handwritten orders, where regex parses 0 items
      // but vision-LLM correctly emits one entry per handwritten line).
      const llmLinesAvailable = llmCombined?.line_items?.length ?? 0;
      const useLlmOrderLines =
        extracted.lineItems.length === 0
          ? llmLinesAvailable > 0
          : llmLinesAvailable > extracted.lineItems.length * 1.5;
      const finalOrderLines = useLlmOrderLines
        ? llmCombined!.line_items.map((li) => ({
            lineNumber: li.line_number,
            description: li.description,
            skuRaw: li.sku_code,
            quantity: li.quantity,
            unitPrice: li.unit_price,
            lineTotal: li.line_total,
          }))
        : extracted.lineItems;

      // Coerce date-like strings to YYYY-MM-DD or null. The LLM occasionally
      // returns "April 23 2026", "2026", or "tomorrow" — postgres rejects
      // those and the entire order insert fails silently. Returning null
      // lets the row land so the operator can review.
      const sanitiseDate = (raw: string | null | undefined): string | null => {
        if (!raw || typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        if (!trimmed) return null;
        // Already in ISO-ish form yyyy-mm-dd[Thh:mm…]
        const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
        // Try generic Date.parse as last resort
        const t = Date.parse(trimmed);
        if (Number.isFinite(t)) {
          const d = new Date(t);
          if (d.getFullYear() > 1990 && d.getFullYear() < 2100) {
            return d.toISOString().slice(0, 10);
          }
        }
        return null;
      };
      const safeOrderDate = sanitiseDate(finalOrderDateWithFallback);
      const safeDeliveryDate = sanitiseDate(finalDeliveryDate);

      const { data: order, error: orderInsertError } = await supabase
        .from('orders')
        .insert({
          document_id: documentId,
          order_number: finalOrderNumberWithFallback,
          order_date: safeOrderDate,
          payment_terms: finalPaymentTerms,
          billing_address: finalBillingAddress,
          customer_name: finalCustomerName,
          customer_code: finalCustomerCode,
          customer_phone: customerPhone ?? llmCombined?.customer_phone ?? null,
          customer_email: llmCombined?.customer_email ?? null,
          customer_whatsapp: customerWhatsApp,
          shipping_address: finalShipTo,
          subtotal: finalSubtotal,
          tax_amount: finalTaxAmount,
          total_amount: finalOrderTotal,
          delivery_date: safeDeliveryDate,
          special_instructions: finalSpecial,
          field_confidences: orderConfidences,
        } as any)
        .select('id')
        .single();

      if (orderInsertError) {
        console.error('[pipeline] order insert failed:', orderInsertError);
        await appendLog(supabase, documentId, 'extraction', 'failed', {
          stage: 'order_insert',
          error: orderInsertError.message,
          details: orderInsertError.details ?? null,
          hint: orderInsertError.hint ?? null,
        });
      }

      if (order && finalOrderLines.length > 0) {
        let masterIndex: ReturnType<typeof buildItemMasterIndex> | null = null;
        const { data: masterRows } = await supabase
          .from('item_master')
          .select('sku_code, upc, description, unit_price')
          .limit(5000);
        if (masterRows && masterRows.length > 0) {
          masterIndex = buildItemMasterIndex(masterRows as ItemMasterLike[]);
        }

        const llmLineByNum = new Map<number, MappedDocument['line_items'][number]>();
        if (llmCombined) {
          for (const li of llmCombined.line_items) llmLineByNum.set(li.line_number, li);
        }

        // Final guard: clamp absurd quantities (anything > 10000 in a
        // produce/grocery/dairy order is almost certainly an OCR/LLM
        // hallucination) and drop fully-empty lines (no name + no qty).
        //
        // Also pre-compute a normalised version of the filename so we can
        // filter out any line item that is essentially the document title
        // (the vision model sometimes reads the printed heading/label at the
        // top of the image and returns it as the only "item" instead of the
        // actual products).
        const fnameNorm = fname
          .replace(/\.[^.]+$/, '')   // strip extension
          .toLowerCase()
          .replace(/[-_]+/g, ' ')    // normalise separators
          .replace(/\s+/g, ' ')
          .trim();

        const sanitised = finalOrderLines
          .map((item, idx) => {
            const llmLine = llmLineByNum.get(item.lineNumber) ?? llmLineByNum.get(idx + 1);
            const masterHit = masterIndex
              ? matchLineToMaster(
                  {
                    sku_code: item.skuRaw,
                    sku_name: llmLine?.sku_name ?? null,
                    description: item.description,
                  },
                  masterIndex
                )
              : null;
            let qty = item.quantity;
            if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0 || qty > 10000) {
              qty = null;
            }
            const sku_name = llmLine?.sku_name ?? masterHit?.description ?? null;
            const description = item.description ?? masterHit?.description ?? null;
            const sku_code = item.skuRaw ?? masterHit?.sku_code ?? null;
            const unit_price = item.unitPrice ?? llmLine?.unit_price ?? masterHit?.unit_price ?? null;
            const line_total = item.lineTotal ?? (qty != null && unit_price != null ? qty * unit_price : null);
            const hasName = !!(sku_name || description || sku_code);
            const hasQty = qty != null;
            if (!hasName && !hasQty) return null;

            // Drop items whose description/sku_name is essentially the document
            // filename stem (vision model reads the printed document title and
            // mistakes it for a product when no real items are visible).
            if (fnameNorm.length > 5) {
              const descNorm = (description || '').toLowerCase().replace(/\s+/g, ' ').trim();
              const nameNorm = (sku_name || '').toLowerCase().replace(/\s+/g, ' ').trim();
              if (
                (descNorm && (fnameNorm.includes(descNorm) || descNorm.includes(fnameNorm))) ||
                (nameNorm && (fnameNorm.includes(nameNorm) || nameNorm.includes(fnameNorm)))
              ) return null;
            }
            return {
              order_id: order.id,
              line_number: item.lineNumber,
              description,
              sku_code,
              sku_name,
              unit_of_measure: llmLine?.unit_of_measure ?? null,
              quantity: qty,
              unit_price,
              line_total,
              sku_matched: !!masterHit,
              field_confidences: {
                ...(llmLine ? { _llm_used: true } : {}),
                ...(masterHit ? { _item_master_used: true } : {}),
              },
            };
          })
          .filter((row): row is NonNullable<typeof row> => row != null)
          // Renumber sequentially so the data table doesn't show gaps.
          .map((row, idx) => ({ ...row, line_number: idx + 1 }));

        if (sanitised.length > 0) {
          await supabase.from('order_lines').insert(sanitised as any);
        }
      }
    }

    await appendLog(supabase, documentId, 'extraction', 'completed');

    // ============ STEP 5: VALIDATION ============
    await appendLog(supabase, documentId, 'validation', 'started');

    const validationResult = await runValidation(supabase, documentId, classification.documentType);

    if (validationResult.allPassed) {
      await updateDoc(supabase, documentId, { status: 'validated' });
      await updateDoc(supabase, documentId, { status: 'ready_for_export' });
    } else {
      await updateDoc(supabase, documentId, { status: 'exception' });
    }

    await appendLog(supabase, documentId, 'validation', 'completed', {
      passed: validationResult.allPassed,
      checks: validationResult.totalChecks,
      failures: validationResult.totalErrors,
    });

    // ============ DONE ============
    const elapsed = Date.now() - startTime;
    await updateDoc(supabase, documentId, {
      total_processing_time_ms: elapsed,
      processed_at: now(),
    });

    await appendLog(supabase, documentId, 'complete', 'completed', { totalMs: elapsed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown processing error';
    console.error(`[Pipeline] Document ${documentId} failed:`, message);

    await updateDoc(supabase, documentId, {
      status: 'failed',
      error_message: message,
      total_processing_time_ms: Date.now() - startTime,
    });

    await appendLog(supabase, documentId, 'complete', 'failed', { error: message });
  }
}
