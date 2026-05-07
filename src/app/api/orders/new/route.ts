import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ORDERS_FOLDER_ID } from '@/lib/gdrive/client';
import { fetchProducts, type SiloItemMaster } from '@/lib/silo/client';
import { extractFromFilename } from '@/lib/processing/extractor';
import { extractOrderFields } from '@/lib/processing/extractor';

export const dynamic = 'force-dynamic';

// ── Item-master enrichment ──────────────────────────────────────
// We pull the Silo product/item-master once per request (cheap — Silo
// caches the JWT) and try to match each extracted order line by:
//   1) exact SKU code (lookupCode)
//   2) exact UPC
//   3) normalized fuzzy match on description / sku_name
// The match metadata is attached to each `order_line` so the UI can render
// a "Matched in Item Master" badge alongside the master's SKU + group.
function normalize(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildMasterIndex(items: SiloItemMaster[]) {
  const bySku = new Map<string, SiloItemMaster>();
  const byUpc = new Map<string, SiloItemMaster>();
  const byName = new Map<string, SiloItemMaster>();
  for (const it of items) {
    if (it.sku_code) bySku.set(it.sku_code.toLowerCase(), it);
    if (it.upc) byUpc.set(it.upc.toLowerCase(), it);
    const n = normalize(it.description);
    if (n) byName.set(n, it);
  }
  return { bySku, byUpc, byName, all: items };
}

interface MatchResult {
  matched: boolean;
  match_method: 'sku' | 'upc' | 'name_exact' | 'name_fuzzy' | null;
  master_sku_code: string | null;
  master_description: string | null;
  master_group: string | null;
  master_location: string | null;
  master_on_hand: number | null;
  master_unit_price: number | null;
}

function matchLine(
  line: { sku_code?: string | null; sku_name?: string | null; description?: string | null },
  index: ReturnType<typeof buildMasterIndex>
): MatchResult {
  const empty: MatchResult = {
    matched: false, match_method: null,
    master_sku_code: null, master_description: null,
    master_group: null, master_location: null, master_on_hand: null, master_unit_price: null,
  };
  const sku = (line.sku_code || '').trim().toLowerCase();
  if (sku) {
    const hit = index.bySku.get(sku) || index.byUpc.get(sku);
    if (hit) return toResult(hit, hit === index.byUpc.get(sku) ? 'upc' : 'sku');
  }
  const name = normalize(line.sku_name || line.description);
  if (!name) return empty;
  const exact = index.byName.get(name);
  if (exact) return toResult(exact, 'name_exact');
  // cheap token-overlap fuzzy
  const tokens = new Set(name.split(' ').filter(t => t.length > 2));
  if (tokens.size === 0) return empty;
  let best: { hit: SiloItemMaster; score: number } | null = null;
  for (const it of index.all) {
    const n = normalize(it.description);
    if (!n) continue;
    const its = new Set(n.split(' ').filter(t => t.length > 2));
    if (its.size === 0) continue;
    let overlap = 0;
    tokens.forEach(t => { if (its.has(t)) overlap++; });
    const score = overlap / Math.max(tokens.size, its.size);
    if (score >= 0.6 && (!best || score > best.score)) best = { hit: it, score };
  }
  return best ? toResult(best.hit, 'name_fuzzy') : empty;
}

function toResult(hit: SiloItemMaster, method: NonNullable<MatchResult['match_method']>): MatchResult {
  return {
    matched: true,
    match_method: method,
    master_sku_code: hit.sku_code,
    master_description: hit.description,
    master_group: hit.group,
    master_location: hit.location,
    master_on_hand: hit.quantity,
    master_unit_price: hit.unitPrice,
  };
}

// Cache the item master in-memory for 5 minutes. We prefer the persistent
// `item_master` table (synced from Silo via /api/item-master/sync) and fall
// back to a live Silo fetch only when the table is empty — that keeps the
// dashboard fast and avoids hitting Silo on every request.
let masterCache: { items: SiloItemMaster[]; expires: number } | null = null;
async function getItemMaster(): Promise<SiloItemMaster[]> {
  if (masterCache && Date.now() < masterCache.expires) return masterCache.items;
  try {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase
      .from('item_master')
      .select('id, sku_code, upc, plu, description, group_name, location, on_hand, unit_price')
      .limit(5000);
    if (!error && data && data.length > 0) {
      const items: SiloItemMaster[] = data.map((r: any) => ({
        id: r.id,
        sku_code: r.sku_code,
        upc: r.upc,
        plu: r.plu,
        description: r.description,
        group: r.group_name,
        location: r.location,
        quantity: r.on_hand != null ? Number(r.on_hand) : null,
        unitPrice: r.unit_price != null ? Number(r.unit_price) : null,
      }));
      masterCache = { items, expires: Date.now() + 5 * 60 * 1000 };
      return items;
    }
    // Empty table → fall back to live Silo so the UI is still useful pre-sync.
    const live = await fetchProducts(500);
    masterCache = { items: live.products, expires: Date.now() + 5 * 60 * 1000 };
    return live.products;
  } catch (e) {
    console.warn('[orders/new] item-master load failed:', (e as Error).message);
    return masterCache?.items || [];
  }
}

function deriveOrderFallbackFromFilename(filename: string | null | undefined, createdAt: string | null | undefined) {
  const hints = extractFromFilename(filename || '');
  const numPrefix = (filename || '').match(/^(\d{4,})\b/)?.[1] || null;
  const derivedOrderNumber = numPrefix || hints.invoiceNumber || null;
  const derivedOrderDate = hints.invoiceDate || (createdAt ? createdAt.slice(0, 10) : null);
  return {
    order_number: derivedOrderNumber,
    order_date: derivedOrderDate,
    customer_name: hints.customerName || null,
  };
}

type OcrLineItem = {
  line_number: number;
  sku_name: string | null;
  sku_code: string | null;
  description: string | null;
  quantity: number | null;
  unit_of_measure: string | null;
  unit_price: number | null;
  line_total: number | null;
  sku_matched: boolean;
};

/**
 * Scan OCR text for food/produce words to recover line items from messy
 * handwritten order scans where the regex extractor returns nothing.
 * This handles the two-column checklist layout where OCR mixes item names
 * and quantities across lines.
 */
function extractFoodWordsFromOcr(text: string): OcrLineItem[] {
  // Core food keywords — matches produce/grocery/dairy domain
  const FOOD_KW = [
    'milk', 'yogurt', 'yoghurt', 'curd', 'butter', 'ghee', 'paneer', 'cheese', 'cream', 'lassi',
    'egg', 'eggs',
    'onion', 'tomato', 'potato', 'potatoes', 'cauliflower', 'cabbage', 'broccoli', 'carrot',
    'cucumber', 'eggplant', 'pepper', 'chilli', 'chili', 'chilly', 'okra', 'bhindi', 'spinach',
    'mint', 'cilantro', 'coriander', 'ginger', 'garlic', 'turmeric', 'lemon', 'lime',
    'mango', 'banana', 'apple', 'papaya', 'papya', 'papya', 'orange', 'muli', 'mooli', 'radish',
    'mushroom', 'celery', 'brinjal', 'pumpkin', 'beetroot', 'roti', 'rati', 'bread', 'pau',
    'puri', 'rice', 'atta', 'flour', 'dal', 'sugar', 'salt', 'oil', 'curry', 'tofu', 'coconut',
    'sour cream', 'heavy cream', 'half', 'mango', 'guava', 'pineapple', 'lychee', 'jackfruit',
    'fansi', 'methi', 'lauki', 'karela', 'tinda', 'parwal', 'arbi', 'suran', 'yam',
  ];
  const foodReStr = FOOD_KW.join('|');
  const foodRe = new RegExp('(' + foodReStr + ')', 'i');

  // Reject lines that look like document titles, not product names
  const isTitle = (s: string): boolean => {
    if (/\b20\d{2}\s+\d{2}\s+\d{2}\b/.test(s)) return true;
    if (/\b20\d{2}[-_]\d{2}[-_]\d{2}\b/.test(s)) return true;
    if (/\b20\d{2}\b/.test(s) && /\b(inventory[\s_-]*list|orders?[\s_-]*list|invoice|scan)\b/i.test(s)) return true;
    return false;
  };

  const seen = new Set<string>();
  const items: OcrLineItem[] = [];
  let lineNum = 1;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.length < 2) continue;
    if (isTitle(line)) continue;
    if (!foodRe.test(line)) continue;

    // Clean OCR noise characters from the start of the line
    const cleaned = line.replace(/^[=\-*•#\d.]+\s*/, '').replace(/\s+/g, ' ').trim();
    if (cleaned.length < 2 || isTitle(cleaned)) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      line_number: lineNum++,
      sku_name: cleaned,
      sku_code: null,
      description: cleaned,
      quantity: null,
      unit_of_measure: null,
      unit_price: null,
      line_total: null,
      sku_matched: false,
    });
  }
  return items;
}

function deriveLinesFromOcrText(ocrRawText: string | null | undefined): OcrLineItem[] {
  if (!ocrRawText || ocrRawText.trim().length < 20) return [];

  const extracted = extractOrderFields(ocrRawText);
  const regexLines: OcrLineItem[] = (extracted.lineItems || [])
    .map((it, idx) => ({
      line_number: it.lineNumber ?? idx + 1,
      sku_name: it.description ?? null,
      sku_code: it.skuRaw ?? null,
      description: it.description ?? null,
      quantity: typeof it.quantity === 'number' && Number.isFinite(it.quantity) ? it.quantity : null,
      unit_of_measure: null,
      unit_price: typeof it.unitPrice === 'number' && Number.isFinite(it.unitPrice) ? it.unitPrice : null,
      line_total: typeof it.lineTotal === 'number' && Number.isFinite(it.lineTotal) ? it.lineTotal : null,
      sku_matched: false,
    }))
    .filter((it) => {
      const hasName = !!((it.sku_name || it.description || it.sku_code || '').trim());
      const hasQty = it.quantity != null;
      return hasName || hasQty;
    });

  if (regexLines.length > 0) return regexLines;

  // Regex extractor found nothing — try food-word scanning as a fallback for
  // handwritten / two-column order sheets where OCR mangles the layout.
  return extractFoodWordsFromOcr(ocrRawText);
}

function isFilenamePlaceholderLine(line: any, originalFilename: string | null | undefined): boolean {
  const name = ((line?.sku_name as string | null) || (line?.description as string | null) || '').trim().toLowerCase();
  const base = (originalFilename || '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .trim()
    .toLowerCase();
  if (!name) return false;
  if (base && (name === base || name.includes(base))) return true;
  if (/photo-\d{4}-\d{2}-\d{2}/i.test(name)) return true;
  if (/^\d{6,}[-_ ]?photo[-_]/i.test(name)) return true;
  return false;
}

export async function GET(req: NextRequest) {
  try {
    const supabase = createServiceRoleClient();
    const { searchParams } = req.nextUrl;
    const debugOcr = searchParams.get('debug_ocr') === '1';
    const limit = Math.min(Number(searchParams.get('limit') || '50'), 200);
    const offset = Number(searchParams.get('offset') || '0');
    const sourceParam = searchParams.get('source') || '';
    const allSources = ['whatsapp', 'email', 'scanner', 'google_drive', 'cloud_upload'];
    const sourceList = sourceParam
      ? sourceParam.split(',').map(s => s.trim()).filter(Boolean)
      : allSources;

    const query = supabase
      .from('orders')
      .select(`
        id, order_number, order_date, delivery_date, customer_name, customer_phone,
        customer_email, customer_whatsapp, customer_code,
        billing_address, shipping_address, payment_terms, special_instructions,
        subtotal, tax_amount, total_amount,
        validation_status, exception_status, export_status, approval_status,
        created_at, updated_at, document_id,
        documents!inner(source, original_filename, received_at, source_identifier, file_mime_type, ocr_raw_text),
        order_lines(line_number, sku_name, sku_code, description, quantity, unit_of_measure, unit_price, line_total, sku_matched)
      `, { count: 'exact' })
      .in('documents.source', sourceList)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, count, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    let rows: any[] = data || [];
    let total = count ?? 0;

    // ────────────────────────────────────────────────────────────────────
    // ORPHAN-DOCUMENT BACKFILL (Google Drive only)
    // ────────────────────────────────────────────────────────────────────
    // Many GDrive documents in the customer-orders folder live in the
    // `documents` table but never produced an `orders` row — either the
    // pipeline hasn't run yet (status='new'), it failed (status='failed'),
    // or the blank-document gate routed them into `invoices` by mistake.
    // The dashboard would otherwise show NOTHING for those rows, which is
    // exactly the bug the user reported ("orders sync ho gaye hain ... data
    // table mein kyon nahi show ho rahe hain").
    //
    // We synthesise placeholder NewOrder-shaped rows for those orphans so:
    //   • The user can see every imported file with a status badge.
    //   • The Reprocess button (visible because validation_status='failed')
    //     can re-run OCR + LLM on each orphan.
    if (sourceList.includes('google_drive') && offset === 0) {
      const presentDocIds = new Set(
        rows.map((r) => r.document_id).filter(Boolean)
      );

      const { data: orphans } = await supabase
        .from('documents')
        .select('id, original_filename, received_at, created_at, status, error_message, gdrive_folder_kind, gdrive_folder_id, source_identifier, file_mime_type, ocr_raw_text')
        .eq('source', 'google_drive' as any)
        // Match by either gdrive_folder_kind='orders' (after migration
        // 20260429000001 is applied) OR by gdrive_folder_id matching the
        // env-configured orders folder. Older imports that pre-date the
        // migration store kind=null but always have the right folder_id.
        .or(`gdrive_folder_kind.eq.orders,gdrive_folder_id.eq.${ORDERS_FOLDER_ID}`)
        .order('created_at', { ascending: false })
        .limit(500);

      const orphanRows = (orphans || [])
        .filter((d: any) => !presentDocIds.has(d.id))
        .map((d: any) => {
          const fallback = deriveOrderFallbackFromFilename(d.original_filename, d.created_at);
          return {
          // Use the document id as the row key so React + the table render
          // cleanly. Downstream actions (Approve / Reprocess) work on
          // document_id, which the dashboard already prefers when set.
          id: d.id,
          document_id: d.id,
          order_number: fallback.order_number,
          order_date: fallback.order_date,
          delivery_date: null,
          customer_name: fallback.customer_name,
          customer_code: null,
          customer_phone: null,
          customer_email: null,
          customer_whatsapp: null,
          billing_address: null,
          shipping_address: null,
          payment_terms: null,
          special_instructions: d.status ? `Pending extraction (${d.status})` : null,
          subtotal: null,
          tax_amount: null,
          total_amount: null,
          // Surface the document's processing state so the row's Status
          // column renders something meaningful and the Reprocess button
          // becomes visible.
          validation_status: d.status === 'failed' || d.status === 'exception' ? 'failed' : 'pending',
          exception_status: d.status === 'exception' ? 'pending' : null,
          export_status: null,
          approval_status: null,
          created_at: d.created_at,
          updated_at: d.created_at,
          documents: {
            source: 'google_drive',
            original_filename: d.original_filename,
            received_at: d.received_at ?? d.created_at,
            source_identifier: d.source_identifier,
            file_mime_type: d.file_mime_type,
            ocr_raw_text: d.ocr_raw_text,
          },
          order_lines: (() => {
            // Use OCR-based extraction (regex → food-word fallback).
            // Do NOT fall back to the filename — that creates misleading
            // "Furnters Order 2026 04 29 Inventory List" fake items.
            return deriveLinesFromOcrText(d.ocr_raw_text);
          })(),
          _orphan_status: d.status,
          _orphan_error: d.error_message,
        };
        });

      // Prepend orphans so they appear first (most likely to need attention).
      rows = [...orphanRows, ...rows];
      total = total + orphanRows.length;
    }

    // ────────────────────────────────────────────────────────────────────
    // ITEM-MASTER ENRICHMENT
    // For each order_line attach { matched, match_method, master_* fields }
    // so the dashboard can show whether the OCR/LLM-extracted item already
    // exists in the Silo item master and surface canonical SKU info.
    // ────────────────────────────────────────────────────────────────────
    const master = await getItemMaster();
    const index = buildMasterIndex(master);
    rows = rows.map((r) => {
      const source = r.documents?.source || null;
      const lines = Array.isArray(r.order_lines) ? r.order_lines : [];
      const ocrLines = source === 'google_drive'
        ? deriveLinesFromOcrText(r.documents?.ocr_raw_text)
        : [];
      const looksPlaceholderOnly =
        source === 'google_drive' &&
        lines.length > 0 &&
        lines.every((l: any) => isFilenamePlaceholderLine(l, r.documents?.original_filename));

      // When a GDrive order has no lines OR only filename-derived placeholders,
      // replace with OCR-extracted lines. If OCR also found nothing, prefer
      // the existing (possibly placeholder) lines over an empty array so the
      // row is still visible; if no existing lines exist, just use empty.
      const effectiveLines = (source === 'google_drive' && (lines.length === 0 || looksPlaceholderOnly))
        ? (ocrLines.length > 0 ? ocrLines : lines)
        : lines;
      return {
        ...r,
        order_lines: effectiveLines.map((l: any) => {
          const itemMaster = matchLine(l, index);
          const qty = l.quantity != null ? Number(l.quantity) : null;
          const unitPrice = l.unit_price != null ? Number(l.unit_price) : itemMaster.master_unit_price;
          const lineTotal = l.line_total != null
            ? Number(l.line_total)
            : (qty != null && unitPrice != null ? qty * unitPrice : null);
          return {
            ...l,
            unit_price: unitPrice,
            line_total: lineTotal,
            item_master: itemMaster,
          };
        }),
        ...(debugOcr && source === 'google_drive' ? {
          _debug: {
            lines_from_db: lines.length,
            ocr_lines: ocrLines.length,
            effective_lines: effectiveLines.length,
            ocr_text_len: (r.documents?.ocr_raw_text || '').length,
            food_direct: extractFoodWordsFromOcr(r.documents?.ocr_raw_text || '').length,
          }
        } : {}),
      };
    });

    return NextResponse.json({ data: rows, total, item_master_count: master.length });
  } catch (err) {
    console.error('New orders API error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}

