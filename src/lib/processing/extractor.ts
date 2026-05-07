export interface ExtractedInvoice {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  vendorName: string | null;
  vendorCode: string | null;
  billToName: string | null;
  billToAddress: string | null;
  subtotal: number | null;
  taxAmount: number | null;
  totalAmount: number | null;
  paymentTerms: string | null;
  dueDate: string | null;
  lineItems: ExtractedLineItem[];
  fieldConfidences: Record<string, number>;
}

export interface ExtractedOrder {
  orderNumber: string | null;
  orderDate: string | null;
  customerName: string | null;
  customerCode: string | null;
  shipToAddress: string | null;
  orderTotal: number | null;
  deliveryDate: string | null;
  specialInstructions: string | null;
  lineItems: ExtractedLineItem[];
  fieldConfidences: Record<string, number>;
}

export interface ExtractedLineItem {
  lineNumber: number;
  description: string | null;
  skuRaw: string | null;
  quantity: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
}

// ---- Pattern-based extraction helpers ----

function findPattern(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function parseNumber(value: string | null): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[,$\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.trim();

  // Try common date formats
  const formats = [
    /(\d{4})-(\d{2})-(\d{2})/,                    // YYYY-MM-DD
    /(\d{2})\/(\d{2})\/(\d{4})/,                    // MM/DD/YYYY
    /(\d{2})-(\d{2})-(\d{4})/,                      // MM-DD-YYYY
    /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{4})/i,
  ];

  const m1 = cleaned.match(formats[0]);
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;

  const m2 = cleaned.match(formats[1]);
  if (m2) return `${m2[3]}-${m2[1]}-${m2[2]}`;

  const m3 = cleaned.match(formats[2]);
  if (m3) return `${m3[3]}-${m3[1]}-${m3[2]}`;

  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const m4 = cleaned.match(formats[3]);
  if (m4) {
    const month = months[m4[2].toLowerCase().substring(0, 3)];
    const day = m4[1].padStart(2, '0');
    return `${m4[3]}-${month}-${day}`;
  }

  // Mon DD, YYYY  (e.g. "Apr 09, 2026")
  const mmd = cleaned.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2}),?\s+(\d{4})/i);
  if (mmd) {
    const month = months[mmd[1].toLowerCase().substring(0, 3)];
    const day = mmd[2].padStart(2, '0');
    return `${mmd[3]}-${month}-${day}`;
  }

  // M/D/YYYY single-digit month/day
  const msd = cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (msd) {
    return `${msd[3]}-${msd[1].padStart(2, '0')}-${msd[2].padStart(2, '0')}`;
  }

  return null;
}

// ---- Invoice extraction ----

export function extractInvoiceFields(text: string): ExtractedInvoice {
  const confidences: Record<string, number> = {};

  const invoiceNumber = findPattern(text, [
    // "Invoice #\n6420" — value on NEXT line (two-column header like Bikaji)
    /invoice\s*#\s*\n\s*([A-Z0-9][A-Z0-9-]*)/i,
    // "Invoice # 6420" or "Invoice No 6420" — same line, REQUIRES # / no / number keyword
    /inv(?:oice)?\s*(?:#|no\.?|number|num)\s*[.:]\s*([A-Z0-9][A-Z0-9-]*)/i,
    /inv(?:oice)?\s*(?:#|no\.?|number|num)\s+([A-Z0-9][A-Z0-9-]*)/i,
    // Generic "#" or "No." followed by alphanumeric (e.g. "# 8510")
    /(?:^|\s)#\s*([A-Z0-9]{3,}[A-Z0-9-]*)/im,
    // Last-resort: "Invoice" followed by a TOKEN that STARTS with a digit (not a word)
    /inv(?:oice)\s+(\d[A-Z0-9-]*)/i,
  ]);
  confidences.invoice_number = invoiceNumber ? 0.8 : 0;

  const invoiceDateRaw = findPattern(text, [
    /inv(?:oice)?\s*date\s*[.:]*\s*(.+)/i,
    /date\s*[.:]*\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /date\s*[.:]*\s*(\d{1,2}\s+\w+\s+\d{4})/i,
    /date\s*[.:]*\s*(\w{3,9}\s+\d{1,2},?\s+\d{4})/i,
    /date\s*[.:]*\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ]);
  const invoiceDate = parseDate(invoiceDateRaw);
  confidences.invoice_date = invoiceDate ? 0.8 : 0;

  // Vendor: try header company name first, then labeled fields
  // The first line of an invoice is often the company name (e.g. "SUPPLY SEVA")
  const vendorName = findPattern(text, [
    /^([A-Z][A-Z\s&.,]{1,40}(?:LLC|Inc|Corp|Ltd|Co\.?))\s*$/m,
    /^([A-Z]{2,}[A-Z\s&.]*?)\n/m,
    /(?:vendor|supplier|sold\s+by)\s*[.:]*\s*([^\n]+)/i,
    /^([A-Z][A-Za-z\s&.,]+)\n\d+\s*[A-Za-z]/m,
  ]);
  confidences.vendor_name = vendorName ? 0.7 : 0;

  const vendorCode = findPattern(text, [
    /vendor\s*(?:code|id|#)\s*[.:]*\s*([A-Z0-9-]+)/i,
  ]);
  confidences.vendor_code = vendorCode ? 0.8 : 0;

  let billToName = findPattern(text, [
    /bill\s*to\s*[.:]*\s*\n([^\n]+)/i,
    /bill\s*to\s*[.:]*\s*([^\n]+)/i,
    /customer\s*[.:]*\s*([^\n]+)/i,
  ]);
  // Skip if extraction picked up a label like "SHIP TO"
  if (billToName && /^ship\s*to$/i.test(billToName)) {
    // Try next line after "SHIP TO"
    const shipToMatch = text.match(/ship\s*to\s*\n([^\n]+)/i);
    billToName = shipToMatch?.[1]?.trim() || null;
  }
  confidences.bill_to_name = billToName ? 0.7 : 0;

  const billToAddress = findPattern(text, [
    /bill\s*to[\s\S]*?(?:address)?\s*[.:]*\s*([\s\S]*?)(?:\n\n|ship|item|qty)/i,
  ]);

  const subtotalRaw = findPattern(text, [
    /sub\s*total\s*[.:]*\s*\$?\s*([\d,]+\.?\d*)/i,
  ]);
  const subtotal = parseNumber(subtotalRaw);
  confidences.subtotal = subtotal !== null ? 0.8 : 0;

  const taxRaw = findPattern(text, [
    /(?:tax|vat|gst)\s*(?:amount)?\s*[.:]*\s*\$?\s*([\d,]+\.?\d*)/i,
  ]);
  const taxAmount = parseNumber(taxRaw);
  confidences.tax_amount = taxAmount !== null ? 0.8 : 0;

  const totalRaw = findPattern(text, [
    /(?:grand\s*)?total\s*(?:amount|due)?\s*[.:]*\s*\$?\s*([\d,]+\.?\d*)/i,
    /amount\s*due\s*[.:]*\s*\$?\s*([\d,]+\.?\d*)/i,
    /balance\s*due\s*[.:]*\s*\$?\s*([\d,]+\.?\d*)/i,
  ]);
  const totalAmount = parseNumber(totalRaw);
  confidences.total_amount = totalAmount !== null ? 0.85 : 0;

  const paymentTerms = findPattern(text, [
    /(?:payment\s*)?terms?\s*[.:]*\s*(net\s*\d+|due\s*on\s*receipt|cod)/i,
  ]);
  confidences.payment_terms = paymentTerms ? 0.7 : 0;

  const dueDateRaw = findPattern(text, [
    /due\s*date\s*[.:]*\s*(.+)/i,
    /pay(?:ment)?\s*(?:by|before)\s*[.:]*\s*(.+)/i,
  ]);
  const dueDate = parseDate(dueDateRaw);
  confidences.due_date = dueDate ? 0.8 : 0;

  const lineItems = extractLineItems(text);

  return {
    invoiceNumber,
    invoiceDate,
    vendorName,
    vendorCode,
    billToName,
    billToAddress,
    subtotal,
    taxAmount,
    totalAmount,
    paymentTerms,
    dueDate,
    lineItems,
    fieldConfidences: confidences,
  };
}

// ---- Order extraction ----

export function extractOrderFields(text: string): ExtractedOrder {
  const confidences: Record<string, number> = {};

  const orderNumber = findPattern(text, [
    /(?:order|po|p\.o\.)\s*(?:#|no|number|num)?[.:]*\s*([A-Z0-9-]+)/i,
    /(?:sales\s*order|customer\s*order)\s*[.:]*\s*([A-Z0-9-]+)/i,
  ]);
  confidences.order_number = orderNumber ? 0.8 : 0;

  const orderDateRaw = findPattern(text, [
    /order\s*date\s*[.:]*\s*(.+)/i,
    /date\s*[.:]*\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
  ]);
  const orderDate = parseDate(orderDateRaw);
  confidences.order_date = orderDate ? 0.8 : 0;

  const customerName = findPattern(text, [
    /(?:customer|buyer|ordered by|bill to)\s*[.:]*\s*(.+)/i,
  ]);
  confidences.customer_name = customerName ? 0.7 : 0;

  const customerCode = findPattern(text, [
    /customer\s*(?:code|id|#)\s*[.:]*\s*([A-Z0-9-]+)/i,
  ]);
  confidences.customer_code = customerCode ? 0.8 : 0;

  const shipToAddress = findPattern(text, [
    /ship\s*to[\s\S]*?(?:address)?\s*[.:]*\s*([\s\S]*?)(?:\n\n|item|qty|order\s*date)/i,
  ]);
  confidences.ship_to_address = shipToAddress ? 0.6 : 0;

  const totalRaw = findPattern(text, [
    /order\s*total\s*[.:]*\s*\$?\s*([\d,]+\.?\d*)/i,
    /(?:grand\s*)?total\s*[.:]*\s*\$?\s*([\d,]+\.?\d*)/i,
  ]);
  const orderTotal = parseNumber(totalRaw);
  confidences.order_total = orderTotal !== null ? 0.85 : 0;

  const deliveryDateRaw = findPattern(text, [
    /(?:delivery|ship|expected)\s*date\s*[.:]*\s*(.+)/i,
  ]);
  const deliveryDate = parseDate(deliveryDateRaw);
  confidences.delivery_date = deliveryDate ? 0.7 : 0;

  const specialInstructions = findPattern(text, [
    /(?:special\s*)?instructions?\s*[.:]*\s*(.+)/i,
    /notes?\s*[.:]*\s*(.+)/i,
  ]);

  const lineItems = extractLineItems(text);

  return {
    orderNumber,
    orderDate,
    customerName,
    customerCode,
    shipToAddress,
    orderTotal,
    deliveryDate,
    specialInstructions,
    lineItems,
    fieldConfidences: confidences,
  };
}

// ---- Line item extraction ----

function extractLineItems(text: string): ExtractedLineItem[] {
  // First try multi-line (Silo-style) extraction, then fall back to single-line patterns
  const items = extractMultiLineItems(text);
  if (items.length > 0) return items;
  // Vendor invoices with "Quantity Item Code Description" columns (e.g. Bikaji)
  const itemCodeDesc = extractItemCodeDescTable(text);
  if (itemCodeDesc.length > 0) return itemCodeDesc;
  // Vendor bills where items are listed as "ItemName (Qty) Brand" (e.g. Mini Feesh)
  const qtyInParens = extractQtyInParensItems(text);
  if (qtyInParens.length > 0) return qtyInParens;
  const single = extractSingleLineItems(text);
  if (single.length > 0) return single;
  return extractChecklistItems(text);
}

/**
 * Handles vendor bills where items appear as "ItemName (Qty) Brand" on one line.
 * Example (Mini Feesh / grocery-store style):
 *   S157*
 *   CinnamonStick3.5oz (20) Deep Spice
 *   Cor-Cumin Pwd 14oz (20) Deep Spice
 *   Citric Acid 4.oz. (40) Deep Spice
 *
 * Detection: 3+ lines matching the pattern before this extractor is activated.
 * The optional SKU code line immediately before an item line (e.g. "S157*") is
 * captured as skuRaw.
 */
function extractQtyInParensItems(text: string): ExtractedLineItem[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Item line: starts with a letter, has (qty) somewhere in the middle, optional brand suffix
  const itemPat = /^([A-Za-z][A-Za-z0-9\s\-\.\/,&']+?)\s+\((\d{1,4})\)\s*(.*)$/;
  // SKU code line: lone alphanumeric code ending in * or # (e.g. "S157*", "S22#", "S39N*")
  const skuPat = /^([A-Z][A-Z0-9\-\/]{0,15}[*#])\s*(?:\/\s*.*)?$/;

  // Only activate when there are 3+ matching item lines
  const matchCount = lines.filter((l) => itemPat.test(l)).length;
  if (matchCount < 3) return [];

  const items: ExtractedLineItem[] = [];
  let lineNum = 1;
  let prevSku: string | null = null;

  for (const line of lines) {
    const skuMatch = line.match(skuPat);
    if (skuMatch) {
      prevSku = skuMatch[1];
      continue;
    }

    const m = line.match(itemPat);
    if (m) {
      const qty = parseInt(m[2], 10);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) { prevSku = null; continue; }
      items.push({
        lineNumber: lineNum++,
        description: m[1].trim(),
        skuRaw: prevSku,
        quantity: qty,
        unitPrice: null,
        lineTotal: null,
      });
      prevSku = null;
      continue;
    }

    // Non-matching, non-SKU line resets SKU context
    prevSku = null;
  }

  return items;
}

/**
 * Handles vendor invoices with a "Quantity Item Code Description" (or similar) table header.
 *   Quantity Item Code Description
 *   6 Premium Milk Ru... Premium Milk Rusk (Bikaji) 600 Gms X 12 Pks Per
 *   Ctn
 * The item code is often truncated (trailing ...) in narrow PDF columns.
 * sku_name is derived as "sku_code description" so the table shows the full combined name.
 */
function extractItemCodeDescTable(text: string): ExtractedLineItem[] {
  const lines = text.split('\n').map((l) => l.trim());

  // Detect header line: must contain BOTH 'Item Code' (or 'Item No') and 'Description'
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/item\s*(?:code|no\.?|number)/i.test(l) && /description/i.test(l)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return [];

  const items: ExtractedLineItem[] = [];
  let lineNum = 1;
  let pending: { qty: number; skuRaw: string; desc: string } | null = null;

  const flush = () => {
    if (!pending) return;
    const desc = pending.desc.trim();
    if (desc) {
      items.push({
        lineNumber: lineNum++,
        description: desc,
        skuRaw: pending.skuRaw,
        quantity: pending.qty,
        unitPrice: null,
        lineTotal: null,
      });
    }
    pending = null;
  };

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Stop at footer / summary / unrelated header rows
    if (/^(discount|total|subtotal|tax|project|invoice\s*date|invoice\s*#|payment|price\s+each|amount|u\/m|hepbur|terms|signed|customer|p\.?o\.?\s*number)/i.test(line)) {
      flush();
      continue;
    }

    // A data row starts with a number (quantity) followed by the item code
    // Case 1: code is truncated with "..." → "6 Premium Milk Ru... Premium Milk Rusk..."
    const truncatedMatch = line.match(/^(\d+(?:\.\d+)?)\s+(.+?\.{2,3})\s+(.{5,})$/);
    // Case 2: code is a short alphanumeric token (no spaces) → "12 PMR600 Premium Milk Rusk..."
    const shortCodeMatch = line.match(/^(\d+(?:\.\d+)?)\s+([A-Za-z0-9\-\/]{2,20})\s+([A-Za-z].{5,})$/);

    if (truncatedMatch || shortCodeMatch) {
      flush();
      const m = (truncatedMatch || shortCodeMatch)!;
      const qty = parseFloat(m[1]);
      if (!isNaN(qty) && qty > 0) {
        pending = {
          qty,
          // Strip trailing dots from truncated codes
          skuRaw: m[2].replace(/\.+$/, '').trim(),
          desc: m[3].trim(),
        };
      }
    } else if (pending) {
      // Continuation of description (wrapped to next line)
      // Only append if line doesn't look like a price / number / barcode
      if (!/^[\d\s.,\-$]+$/.test(line)) {
        pending.desc += ' ' + line;
      }
    }
  }
  flush();

  return items;
}

function parseChecklistQuantity(line: string): number | null {
  const t = line.trim().toLowerCase();
  if (!t) return null;
  // Examples: "3bags", "2 bags", "5 lb", "1 box", "2 buckets", "5 pcs"
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(?:bags?|bag|boxes?|box|pcs?|pieces?|lb|lbs|kg|kgs|bucket|buckets|ea|each|case|cases)?\s*$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) return null;
  return n;
}

function isLikelyNameLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^(qty|quantity|name|item|नाम|मात्रा)$/i.test(t)) return false;
  if (parseChecklistQuantity(t) != null) return false;
  if (/^[\d\W]+$/.test(t)) return false;
  // Need at least one alphabetic char (English/Hindi scripts)
  if (!/[A-Za-z\u0900-\u097F]/.test(t)) return false;
  return true;
}

function extractChecklistItems(text: string): ExtractedLineItem[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const hasChecklistHint = lines.some((l) => /^(qty|quantity|name|item|नाम|मात्रा)$/i.test(l));
  if (!hasChecklistHint) return [];

  const qtys: number[] = [];
  const names: string[] = [];
  for (const line of lines) {
    if (/^(qty|quantity|name|item|नाम|मात्रा)$/i.test(line)) continue;
    const q = parseChecklistQuantity(line);
    if (q != null) {
      qtys.push(q);
      continue;
    }
    if (isLikelyNameLine(line)) {
      names.push(line.replace(/\s+/g, ' ').trim());
    }
  }

  if (names.length === 0) return [];

  // Pair quantities to names by order. Extra names get null quantity.
  return names.map((name, idx) => ({
    lineNumber: idx + 1,
    description: name,
    skuRaw: null,
    quantity: qtys[idx] ?? null,
    unitPrice: null,
    lineTotal: null,
  }));
}

/**
 * Multi-line item extraction for Silo/Supply-Seva-style invoices where OCR produces:
 *   Qty
 *   ITEM NAME - DESCRIPTION
 *   (optional continuation lines)
 *   unit
 *   label/category
 *   $unit_price
 *   $amount
 *
 * Detection strategy: find the "Qty Item" header row, then parse blocks of lines
 * where a number (qty) is followed by item description lines then price lines.
 */
function extractMultiLineItems(text: string): ExtractedLineItem[] {
  const items: ExtractedLineItem[] = [];
  const lines = text.split('\n').map(l => l.trim());

  // Find the table header — look for "Qty" followed by "Item" (same or next line)
  let tableStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*Qty\s+Item/i.test(lines[i]) || /^\s*Qty\s.*Unit\s*Price\s*Amount/i.test(lines[i])) {
      tableStart = i + 1;
      break;
    }
    // Also match "Qty" alone on a line (next line should be "Item" or similar header)
    if (/^\s*Qty\s*$/i.test(lines[i])) {
      tableStart = i + 1;
      break;
    }
  }

  if (tableStart < 0) return [];

  // Find table end — look for summary lines like "Inventory units:", "Total:", etc.
  let tableEnd = lines.length;
  for (let i = tableStart; i < lines.length; i++) {
    if (/^(Inventory\s+units|Total\s*pallets|Invoice\s*#|SIGNATURE|Total:|Previous\s+account|Current\s+account|Date\s+ordered|Last\s+updated|Approx)/i.test(lines[i])) {
      tableEnd = i;
      break;
    }
  }

  // Parse item blocks between tableStart and tableEnd
  // Strategy: a new item starts when we see a line that is just a number (qty)
  // or a line starting with a number followed by item text
  let lineNum = 1;
  let i = tableStart;

  while (i < tableEnd) {
    const line = lines[i];
    if (!line) { i++; continue; }

    // Skip column sub-headers or separators
    if (/^[-=_]{3,}$/.test(line) || /^\s*$/.test(line)) { i++; continue; }

    let qty: number | null = null;
    let itemName: string | null = null;
    let unitPrice: number | null = null;
    let amount: number | null = null;
    const descParts: string[] = [];

    // Check if line is just a quantity number (possibly with a dash after it: "148" or "148  -")
    const qtyOnlyMatch = line.match(/^(\d+(?:\.\d+)?)\s*[-–]?\s*$/);
    // Or check if qty + item name on same line: "148  DAIRY MILK - WM GAL (COL)"  or "5\tDAIRY HEAVY CREAM..."
    const qtyAndItemMatch = line.match(/^(\d+(?:\.\d+)?)\s{2,}(.+)$/);

    if (qtyOnlyMatch) {
      // Qty is alone on this line
      qty = parseNumber(qtyOnlyMatch[1]);
      i++;

      // Next lines should be: item name (possibly multi-line), unit, label, price, amount
      // Collect non-numeric text lines as description until we hit a price line
      while (i < tableEnd) {
        const next = lines[i];
        if (!next) { i++; continue; }

        // Check if this is a price line: starts with $ or is just a number like "4.25" or "$4.25"
        const priceMatch = next.match(/^\$\s*([\d,]+\.?\d*)\s*$/);
        const plainNumMatch = next.match(/^([\d,]+\.\d{2})\s*$/);

        if (priceMatch || plainNumMatch) {
          const val = parseNumber(priceMatch ? priceMatch[1] : plainNumMatch![1]);
          if (unitPrice === null) {
            unitPrice = val;
          } else {
            amount = val;
            i++;
            break;
          }
          i++;
          continue;
        }

        // Check if this is a new qty line (start of next item)
        if (/^\d+(?:\.\d+)?\s*[-–]?\s*$/.test(next) || /^\d+(?:\.\d+)?\s{2,}.+/.test(next)) {
          break; // Don't advance i — let outer loop handle it
        }

        // Check for known non-item metadata lines
        if (/^(Inventory\s+units|Total\s*pallets|Invoice\s*#|SIGNATURE|Total:|Previous|Current|Date\s+ordered|Last\s+updated|Approx|Cost)/i.test(next)) {
          break;
        }

        // Otherwise it's part of the item description/unit/label
        // Filter out known unit/label words that we don't want in description
        const isUnitOrLabel = /^(gal|lb|lbs?|kg|oz|ct|pcs?|case|cases|box|boxes|bundle|each|ea|dozen|dz|Dairy|Vegetable|Frozen|Fruit|Grocery|Meat|Seafood|Bakery|Deli|Beverage|Paper\s*Products?|Produce|Indian)\s*$/i.test(next);
        const isUnitSpec = /^\d+\s*(x\s*)?\d*\s*(lb|qt|oz|ct|gal|pc|kg)\s*(case|box|bundle)?\s*$/i.test(next);

        if (!isUnitOrLabel && !isUnitSpec) {
          descParts.push(next);
        }
        i++;
      }
    } else if (qtyAndItemMatch) {
      // Qty and item name on same line
      qty = parseNumber(qtyAndItemMatch[1]);
      descParts.push(qtyAndItemMatch[2]);
      i++;

      // Continue collecting description lines and then prices
      while (i < tableEnd) {
        const next = lines[i];
        if (!next) { i++; continue; }

        const priceMatch = next.match(/^\$\s*([\d,]+\.?\d*)\s*$/);
        const plainNumMatch = next.match(/^([\d,]+\.\d{2})\s*$/);

        if (priceMatch || plainNumMatch) {
          const val = parseNumber(priceMatch ? priceMatch[1] : plainNumMatch![1]);
          if (unitPrice === null) {
            unitPrice = val;
          } else {
            amount = val;
            i++;
            break;
          }
          i++;
          continue;
        }

        if (/^\d+(?:\.\d+)?\s*[-–]?\s*$/.test(next) || /^\d+(?:\.\d+)?\s{2,}.+/.test(next)) {
          break;
        }

        if (/^(Inventory\s+units|Total\s*pallets|Invoice\s*#|SIGNATURE|Total:|Previous|Current|Date\s+ordered|Last\s+updated|Approx|Cost)/i.test(next)) {
          break;
        }

        const isUnitOrLabel = /^(gal|lb|lbs?|kg|oz|ct|pcs?|case|cases|box|boxes|bundle|each|ea|dozen|dz|Dairy|Vegetable|Frozen|Fruit|Grocery|Meat|Seafood|Bakery|Deli|Beverage|Paper\s*Products?|Produce|Indian)\s*$/i.test(next);
        const isUnitSpec = /^\d+\s*(x\s*)?\d*\s*(lb|qt|oz|ct|gal|pc|kg)\s*(case|box|bundle)?\s*$/i.test(next);

        if (!isUnitOrLabel && !isUnitSpec) {
          descParts.push(next);
        }
        i++;
      }
    } else {
      // Not a recognizable item start — skip
      i++;
      continue;
    }

    // Build item if we got valid data
    if (qty !== null && descParts.length > 0) {
      itemName = descParts.join(' ').replace(/\s+/g, ' ').trim();
      // Remove trailing dashes or orphan characters
      itemName = itemName.replace(/\s*[-–]\s*$/, '').trim();

      if (itemName.length > 1) {
        const skuMatch = itemName.match(/([A-Z]{2,}[\d-]+)/);
        items.push({
          lineNumber: lineNum++,
          description: itemName,
          skuRaw: skuMatch?.[1] ?? null,
          quantity: qty,
          unitPrice: unitPrice,
          lineTotal: amount ?? (qty && unitPrice ? qty * unitPrice : null),
        });
      }
    }
  }

  return items;
}

/** Single-line item extraction — fallback for standard tabular formats */
function extractSingleLineItems(text: string): ExtractedLineItem[] {
  const items: ExtractedLineItem[] = [];
  const lines = text.split('\n');

  // Skip header/summary lines
  const skipPatterns = [
    /^\s*(?:invoice|order|bill|ship|from|to|date|due|terms?|payment|sub\s*total|total|tax|vat|gst|amount|balance|customer|vendor|supplier|address|phone|fax|email|page|thank|note|memo|po\s*box|www\.|http)/i,
    /^\s*(?:qty|quantity|description|item|product|unit|price|amount|rate|total|sr\.?\s*no|s\.?\s*no|sl\.?\s*no|#)\s*$/i,
    /^\s*[-=_]{3,}\s*$/,
    /^\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*$/,
  ];

  // Pattern 1: Full tabular — line# desc qty price total (with 1+ space/tab separators)
  const fullTabular =
    /^[\s#]*(\d+)?[.\s)]*(.+?)[\s\t]+(\d+(?:\.\d+)?)[\s\t]+\$?\s*([\d,]+\.?\d*)[\s\t]+\$?\s*([\d,]+\.?\d*)\s*$/;

  // Pattern 2: desc qty price (no line total)
  const descQtyPrice =
    /^[\s#]*(\d+)?[.\s)]*(.+?)[\s\t]+(\d+(?:\.\d+)?)[\s\t]+\$?\s*([\d,]+\.?\d*)\s*$/;

  // Pattern 3: qty x price format — "Widget Blue 10 x 5.99 = 59.90" or "10 x Widget @ 5.99"
  const qtyTimesPrice =
    /^(.+?)\s+(\d+(?:\.\d+)?)\s*[xX×]\s*\$?\s*([\d,.]+)\s*(?:=\s*\$?\s*([\d,.]+))?$/;

  // Pattern 4: qty @ price — "Widget Blue - 10 @ $5.99" or "10 pcs @ 5.99"
  const qtyAtPrice =
    /^(.+?)[\s\-–]+(\d+(?:\.\d+)?)\s*(?:pcs?|nos?|kg|lbs?|units?|boxes?|cases?|ea)?\s*@\s*\$?\s*([\d,.]+)\s*(?:=\s*\$?\s*([\d,.]+))?$/i;

  // Pattern 5: Labeled fields — "Qty: 10 Rate: 5.99 Amount: 59.90" or desc on previous line
  const labeledQty =
    /(?:qty|quantity)\s*[.:]\s*(\d+(?:\.\d+)?)/i;
  const labeledRate =
    /(?:rate|price|unit\s*price|unit\s*cost)\s*[.:]\s*\$?\s*([\d,.]+)/i;
  const labeledAmount =
    /(?:amount|total|line\s*total|ext(?:ended)?)\s*[.:]\s*\$?\s*([\d,.]+)/i;

  // Pattern 6: Tab-separated (common in OCR) — fields separated by \t
  const tabSeparated =
    /^([^\t]+)\t+(\d+(?:\.\d+)?)\t+\$?\s*([\d,]+\.?\d*)\t+\$?\s*([\d,]+\.?\d*)$/;

  // Pattern 7: Pipe-separated — "Widget Blue | 10 | 5.99 | 59.90"
  const pipeSeparated =
    /^([^|]+)\|([^|]+)\|([^|]+)(?:\|([^|]+))?$/;

  // Pattern 8: Just description and amount at end of line — "Widget Blue ......... $59.90" or "Widget Blue 59.90"
  const descAndAmount =
    /^[\s#]*(\d+)?[.\s)]*([A-Za-z][A-Za-z\s&.,\-\/]+?)[\s.…]+\$?\s*([\d,]+\.\d{2})\s*$/;

  let lineNum = 1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 3) continue;

    // Skip headers/labels
    if (skipPatterns.some(p => p.test(trimmed))) continue;

    let match: RegExpMatchArray | null;

    // Try tab-separated first (OCR often produces tabs)
    match = trimmed.match(tabSeparated);
    if (match) {
      const descRaw = match[1].trim();
      if (descRaw.length > 1) {
        const skuMatch = descRaw.match(/([A-Z]{2,}[\d-]+)/);
        items.push({
          lineNumber: lineNum++,
          description: descRaw,
          skuRaw: skuMatch?.[1] ?? null,
          quantity: parseNumber(match[2]),
          unitPrice: parseNumber(match[3]),
          lineTotal: parseNumber(match[4]),
        });
        continue;
      }
    }

    // Try full tabular (the original strict pattern, now with single-space support)
    match = trimmed.match(fullTabular);
    if (match) {
      const descRaw = match[2].trim();
      if (descRaw.length > 1 && !/^(sub\s*total|total|tax|balance|amount)/i.test(descRaw)) {
        const skuMatch = descRaw.match(/([A-Z]{2,}[\d-]+)/);
        items.push({
          lineNumber: lineNum++,
          description: skuMatch ? descRaw.replace(skuMatch[0], '').trim() || descRaw : descRaw,
          skuRaw: skuMatch?.[1] ?? null,
          quantity: parseNumber(match[3]),
          unitPrice: parseNumber(match[4]),
          lineTotal: parseNumber(match[5]),
        });
        continue;
      }
    }

    // Try pipe-separated
    match = trimmed.match(pipeSeparated);
    if (match) {
      const descRaw = match[1].trim();
      const col2 = match[2].trim();
      const col3 = match[3].trim();
      const col4 = match[4]?.trim();
      const qty = parseNumber(col2);
      const price = parseNumber(col3);
      if (descRaw.length > 1 && qty !== null && price !== null) {
        const skuMatch = descRaw.match(/([A-Z]{2,}[\d-]+)/);
        items.push({
          lineNumber: lineNum++,
          description: descRaw,
          skuRaw: skuMatch?.[1] ?? null,
          quantity: qty,
          unitPrice: price,
          lineTotal: col4 ? parseNumber(col4) : (qty && price ? qty * price : null),
        });
        continue;
      }
    }

    // Try qty x price format
    match = trimmed.match(qtyTimesPrice);
    if (match) {
      const descRaw = match[1].trim();
      if (descRaw.length > 1) {
        const skuMatch = descRaw.match(/([A-Z]{2,}[\d-]+)/);
        items.push({
          lineNumber: lineNum++,
          description: descRaw,
          skuRaw: skuMatch?.[1] ?? null,
          quantity: parseNumber(match[2]),
          unitPrice: parseNumber(match[3]),
          lineTotal: parseNumber(match[4]),
        });
        continue;
      }
    }

    // Try qty @ price format
    match = trimmed.match(qtyAtPrice);
    if (match) {
      const descRaw = match[1].trim();
      if (descRaw.length > 1) {
        const skuMatch = descRaw.match(/([A-Z]{2,}[\d-]+)/);
        const qty = parseNumber(match[2]);
        const price = parseNumber(match[3]);
        items.push({
          lineNumber: lineNum++,
          description: descRaw,
          skuRaw: skuMatch?.[1] ?? null,
          quantity: qty,
          unitPrice: price,
          lineTotal: parseNumber(match[4]) ?? (qty && price ? qty * price : null),
        });
        continue;
      }
    }

    // Try desc qty price (no line total, 2 numeric columns)
    match = trimmed.match(descQtyPrice);
    if (match) {
      const descRaw = match[2].trim();
      const possibleQty = parseNumber(match[3]);
      const possiblePrice = parseNumber(match[4]);
      // Only match if desc doesn't look like a total/summary line
      if (descRaw.length > 1 && possibleQty !== null && possiblePrice !== null
          && !/^(sub\s*total|total|tax|balance|amount|discount|shipping|freight|due)/i.test(descRaw)) {
        const skuMatch = descRaw.match(/([A-Z]{2,}[\d-]+)/);
        items.push({
          lineNumber: lineNum++,
          description: descRaw,
          skuRaw: skuMatch?.[1] ?? null,
          quantity: possibleQty,
          unitPrice: possiblePrice,
          lineTotal: possibleQty * possiblePrice,
        });
        continue;
      }
    }

    // Try labeled fields on single line — "Item: Widget Qty: 10 Rate: 5.99 Amount: 59.90"
    const qtyMatch = trimmed.match(labeledQty);
    const rateMatch = trimmed.match(labeledRate);
    if (qtyMatch && rateMatch) {
      const amtMatch = trimmed.match(labeledAmount);
      // Extract description: everything before "qty:"
      const descPart = trimmed.replace(labeledQty, '').replace(labeledRate, '').replace(labeledAmount, '').trim();
      const cleanDesc = descPart.replace(/^[\s:.\-,]+|[\s:.\-,]+$/g, '').trim();
      const qty = parseNumber(qtyMatch[1]);
      const price = parseNumber(rateMatch[1]);
      if (cleanDesc.length > 1) {
        const skuMatch = cleanDesc.match(/([A-Z]{2,}[\d-]+)/);
        items.push({
          lineNumber: lineNum++,
          description: cleanDesc,
          skuRaw: skuMatch?.[1] ?? null,
          quantity: qty,
          unitPrice: price,
          lineTotal: amtMatch ? parseNumber(amtMatch[1]) : (qty && price ? qty * price : null),
        });
        continue;
      }
    }

    // Try desc and amount only (dotted leader pattern common in invoices)
    match = trimmed.match(descAndAmount);
    if (match) {
      const descRaw = match[2].trim();
      if (descRaw.length > 2 && !/^(sub\s*total|total|tax|balance|amount|discount|shipping|freight|due|grand)/i.test(descRaw)) {
        const skuMatch = descRaw.match(/([A-Z]{2,}[\d-]+)/);
        items.push({
          lineNumber: lineNum++,
          description: descRaw,
          skuRaw: skuMatch?.[1] ?? null,
          quantity: 1,
          unitPrice: parseNumber(match[3]),
          lineTotal: parseNumber(match[3]),
        });
        continue;
      }
    }
  }

  return items;
}

// ---- Filename-based extraction ----
//
// Many of our Drive uploads follow predictable naming conventions, e.g.
//   2026-04-05_Sankaj_Invoice_362879.jpg
//   2026-04-23_Sankaj_Invoice_12345_ABC_Corp.jpg
//   2026-04-02_Sankajhd_Vendor_Bill_1001066533.jpg
//   2026-04-01_Smile_Onion_7_Inc_Invoice_13618.jpg
//
// When OCR / regex extraction can't recover key fields (because the image
// quality is too low or the layout is unfamiliar) we still want the data
// table to show *something* in every column. This helper teases the obvious
// fields out of the filename so downstream callers can fall back to them.

export interface FilenameHints {
  invoiceDate: string | null;   // YYYY-MM-DD
  vendorName: string | null;
  invoiceNumber: string | null;
  documentTypeHint: 'invoice' | 'order' | 'receipt' | 'bill' | null;
  customerName: string | null;
}

const TYPE_WORDS: Record<string, FilenameHints['documentTypeHint']> = {
  invoice: 'invoice',
  bill: 'bill',
  order: 'order',
  po: 'order',
  receipt: 'receipt',
};

export function extractFromFilename(filename: string | null | undefined): FilenameHints {
  const empty: FilenameHints = {
    invoiceDate: null,
    vendorName: null,
    invoiceNumber: null,
    documentTypeHint: null,
    customerName: null,
  };
  if (!filename) return empty;

  // Strip extension and split on common separators (_ - space).
  const base = filename.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const parts = base.split(/[_\-\s]+/).filter(Boolean);
  if (parts.length === 0) return empty;

  // 1. Date (YYYY-MM-DD anywhere) — usually the first token.
  let invoiceDate: string | null = null;
  for (const p of parts) {
    if (/^\d{4}$/.test(p)) {
      // Maybe split form: 2026 04 05
      const idx = parts.indexOf(p);
      const m = parts[idx + 1];
      const d = parts[idx + 2];
      if (m && d && /^\d{1,2}$/.test(m) && /^\d{1,2}$/.test(d)) {
        invoiceDate = `${p}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        break;
      }
    }
  }
  if (!invoiceDate) {
    const dateMatch = base.match(/(\d{4})[-_/](\d{1,2})[-_/](\d{1,2})/);
    if (dateMatch) {
      invoiceDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
    }
  }

  // 2. Document-type hint — first token that matches a known type word.
  let typeIdx = -1;
  let documentTypeHint: FilenameHints['documentTypeHint'] = null;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i].toLowerCase();
    if (TYPE_WORDS[key]) {
      documentTypeHint = TYPE_WORDS[key];
      typeIdx = i;
      break;
    }
  }

  // 3. Vendor name = tokens between the date and the type word (excl. dashes
  //    and standalone numbers). Falls back to "first non-date token" if no
  //    type word was found.
  const dateIdx = parts.findIndex(p => /^\d{4}$/.test(p));
  const vendorTokens: string[] = [];
  const sliceEnd = typeIdx >= 0 ? typeIdx : Math.min(dateIdx + 4, parts.length);
  for (let i = Math.max(dateIdx + 1, 0); i < sliceEnd; i++) {
    const p = parts[i];
    if (/^\d+$/.test(p)) continue;            // skip standalone numbers
    if (/^\d{1,2}$/.test(p)) continue;        // month / day fragments
    vendorTokens.push(p);
  }
  let vendorName = vendorTokens.join(' ').trim() || null;
  if (vendorName) {
    // Title-case (preserve all-uppercase abbreviations of length ≤ 3)
    vendorName = vendorName
      .split(/\s+/)
      .map(w => (w.length <= 3 && w === w.toUpperCase())
        ? w
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  // 4. Invoice number = first numeric token AFTER the type word (if any).
  let invoiceNumber: string | null = null;
  if (typeIdx >= 0) {
    for (let i = typeIdx + 1; i < parts.length; i++) {
      if (/^\d{2,}$/.test(parts[i])) { invoiceNumber = parts[i]; break; }
    }
  } else {
    // No type word — use the last numeric token in the name.
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^\d{3,}$/.test(parts[i])) { invoiceNumber = parts[i]; break; }
    }
  }

  // 5. Customer name = trailing tokens after the invoice-number, if any.
  let customerName: string | null = null;
  if (invoiceNumber) {
    const idx = parts.lastIndexOf(invoiceNumber);
    if (idx >= 0 && idx < parts.length - 1) {
      const tail = parts
        .slice(idx + 1)
        .filter(p => !/^\d+$/.test(p))
        .join(' ')
        .trim();
      if (tail) {
        customerName = tail
          .split(/\s+/)
          .map(w => (w.length <= 3 && w === w.toUpperCase())
            ? w
            : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ');
      }
    }
  }

  return {
    invoiceDate,
    vendorName,
    invoiceNumber,
    documentTypeHint,
    customerName,
  };
}

