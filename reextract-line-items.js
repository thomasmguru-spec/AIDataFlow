/**
 * Re-extract line items from existing OCR text in the database.
 * This re-runs the multi-line extractor on all invoices that have
 * OCR text but no invoice_lines rows.
 */
require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function parseNumber(value) {
  if (!value) return null;
  const cleaned = value.replace(/[,$\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function extractMultiLineItems(text) {
  const items = [];
  const lines = text.split('\n').map(l => l.trim());

  // Find table header
  let tableStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*Qty\s+Item/i.test(lines[i]) || /^\s*Qty\s.*Unit\s*Price\s*Amount/i.test(lines[i])) {
      tableStart = i + 1;
      break;
    }
    if (/^\s*Qty\s*$/i.test(lines[i])) {
      tableStart = i + 1;
      break;
    }
  }
  if (tableStart < 0) return [];

  // Find table end
  let tableEnd = lines.length;
  for (let i = tableStart; i < lines.length; i++) {
    if (/^(Inventory\s+units|Total\s*pallets|Invoice\s*#|SIGNATURE|Total:|Previous\s+account|Current\s+account|Date\s+ordered|Last\s+updated|Approx)/i.test(lines[i])) {
      tableEnd = i;
      break;
    }
  }

  let lineNum = 1;
  let i = tableStart;

  while (i < tableEnd) {
    const line = lines[i];
    if (!line) { i++; continue; }
    if (/^[-=_]{3,}$/.test(line)) { i++; continue; }

    let qty = null;
    let unitPrice = null;
    let amount = null;
    const descParts = [];

    const qtyOnlyMatch = line.match(/^(\d+(?:\.\d+)?)\s*[-–]?\s*$/);
    const qtyAndItemMatch = line.match(/^(\d+(?:\.\d+)?)\s{2,}(.+)$/);

    if (qtyOnlyMatch) {
      qty = parseNumber(qtyOnlyMatch[1]);
      i++;

      while (i < tableEnd) {
        const next = lines[i];
        if (!next) { i++; continue; }

        const priceMatch = next.match(/^\$\s*([\d,]+\.?\d*)\s*$/);
        const plainNumMatch = next.match(/^([\d,]+\.\d{2})\s*$/);

        if (priceMatch || plainNumMatch) {
          const val = parseNumber(priceMatch ? priceMatch[1] : plainNumMatch[1]);
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
    } else if (qtyAndItemMatch) {
      qty = parseNumber(qtyAndItemMatch[1]);
      descParts.push(qtyAndItemMatch[2]);
      i++;

      while (i < tableEnd) {
        const next = lines[i];
        if (!next) { i++; continue; }

        const priceMatch = next.match(/^\$\s*([\d,]+\.?\d*)\s*$/);
        const plainNumMatch = next.match(/^([\d,]+\.\d{2})\s*$/);

        if (priceMatch || plainNumMatch) {
          const val = parseNumber(priceMatch ? priceMatch[1] : plainNumMatch[1]);
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
      i++;
      continue;
    }

    if (qty !== null && descParts.length > 0) {
      let itemName = descParts.join(' ').replace(/\s+/g, ' ').trim();
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

async function main() {
  // Get all invoices with their document OCR text
  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('id, invoice_number, document_id')
    .order('id');

  if (invErr) { console.error('Error fetching invoices:', invErr); return; }
  console.log(`Found ${invoices.length} invoices total`);

  // Check which already have line items
  const { data: existingLines } = await supabase
    .from('invoice_lines')
    .select('invoice_id');
  
  const invoicesWithLines = new Set((existingLines || []).map(l => l.invoice_id));
  const invoicesToProcess = invoices.filter(inv => !invoicesWithLines.has(inv.id));
  console.log(`${invoicesToProcess.length} invoices without line items`);

  let totalExtracted = 0;
  let successCount = 0;

  for (const inv of invoicesToProcess) {
    if (!inv.document_id) continue;

    // Get OCR text
    const { data: doc } = await supabase
      .from('documents')
      .select('ocr_raw_text')
      .eq('id', inv.document_id)
      .single();

    if (!doc?.ocr_raw_text) continue;

    const lineItems = extractMultiLineItems(doc.ocr_raw_text);

    if (lineItems.length > 0) {
      const { error: insertErr } = await supabase
        .from('invoice_lines')
        .insert(
          lineItems.map(item => ({
            invoice_id: inv.id,
            line_number: item.lineNumber,
            description: item.description,
            sku_code: item.skuRaw,
            quantity: item.quantity,
            unit_price: item.unitPrice,
            line_total: item.lineTotal,
            field_confidences: {},
          }))
        );

      if (insertErr) {
        console.error(`  Invoice ${inv.invoice_number}: INSERT ERROR:`, insertErr.message);
      } else {
        console.log(`  Invoice ${inv.invoice_number}: extracted ${lineItems.length} items`);
        totalExtracted += lineItems.length;
        successCount++;
      }
    } else {
      console.log(`  Invoice ${inv.invoice_number}: no items found`);
    }
  }

  console.log(`\nDone! Extracted ${totalExtracted} line items across ${successCount} invoices`);
}

main().catch(console.error);
