/**
 * LLM-based document mapper.
 *
 * Why this exists:
 *   The regex extractor uses positional parsing and fixed header names.
 *   It cannot reliably handle:
 *     - "Product Code" / "Item Code" / "SKU" → sku_code mapping
 *     - "Item" / "Product" / "Description" / "Particulars" → description
 *     - "Vendor" vs "Supplier" vs "Sold By" vs "From" → vendor_name
 *     - "Bill To" vs "Billed To" vs "Customer" vs "Sold To" → bill_to_name
 *     - "Customer Name" vs "Buyer" vs "Ordered By" → customer_name
 *
 *   This module sends the OCR text (or any extracted text — email body,
 *   WhatsApp caption, etc.) to an LLM via OpenRouter with explicit synonym
 *   rules so non-standard layouts still land in the right database columns.
 *
 * Provider:
 *   OpenRouter (https://openrouter.ai). Default model is a free model that
 *   has been verified to work. Override via OPENROUTER_MODEL env var.
 *   Falls through a list of candidate models if the primary returns 429.
 */

export interface MappedLineItem {
  line_number: number;
  description: string | null;
  sku_code: string | null;
  sku_name: string | null;
  unit_of_measure: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
}

/**
 * Unified shape covering both invoice and order schemas. The caller decides
 * which fields to use based on document type.
 */
export interface MappedDocument {
  // Invoice / order header
  invoice_number: string | null;
  order_number: string | null;
  invoice_date: string | null; // ISO YYYY-MM-DD
  order_date: string | null;
  due_date: string | null;
  delivery_date: string | null;
  payment_terms: string | null;
  currency: string | null;

  // Vendor (invoice only)
  vendor_name: string | null;
  vendor_code: string | null;
  vendor_address: string | null;
  vendor_email: string | null;
  vendor_phone: string | null;
  vendor_gstin: string | null;

  // Bill-to / customer
  bill_to_name: string | null;
  bill_to_address: string | null;
  customer_name: string | null;
  customer_code: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  shipping_address: string | null;

  // Amounts
  subtotal: number | null;
  tax_amount: number | null;
  discount_amount: number | null;
  total_amount: number | null;

  line_items: MappedLineItem[];
  /** 0-1 confidence reported by the model */
  confidence: number;
  /** Notes from the model (e.g. "Mapped 'Product Code' column to sku_code"). */
  notes: string | null;
}

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Verified working free models on OpenRouter (in order of preference).
// gpt-oss-120b gave the best invoice extraction quality during testing.
const FREE_MODEL_FALLBACK_CHAIN = [
  'openai/gpt-oss-120b:free',
  'openai/gpt-oss-20b:free',
  'google/gemma-3-27b-it:free',
  'nvidia/nemotron-nano-9b-v2:free',
];

// Vision-capable free models on OpenRouter (used for handwritten / WhatsApp
// photo orders where OCR text alone is unreliable). Order matters — we try
// the most capable first and fall through on rate-limit / 404 / 5xx errors.
// Note: free model availability shifts month-to-month; the chain is long so
// at least one is almost always reachable.
const VISION_MODEL_FALLBACK_CHAIN = [
  // Verified available on OpenRouter free tier (2026-04). Order: most-capable first.
  'google/gemma-3-27b-it:free',
  'google/gemma-3-12b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'baidu/qianfan-ocr-fast:free',
  'google/gemma-3-4b-it:free',
  // Legacy ids — kept as last-ditch fallbacks in case OpenRouter restores them.
  'meta-llama/llama-3.2-90b-vision-instruct:free',
  'qwen/qwen2.5-vl-72b-instruct:free',
  'meta-llama/llama-3.2-11b-vision-instruct:free',
  'mistralai/pixtral-12b:free',
];

const SYSTEM_PROMPT = `You are a document data extraction assistant for an invoice/order processing system.

You receive OCR text from a scanned invoice, purchase order, email body, or WhatsApp message and you must return a strict JSON object that maps the data to a fixed database schema, regardless of how the source document labels its columns and fields.

═══════════════════════════════════════════════════════════════════════════════
GENERAL PRINCIPLE — READ FIRST
═══════════════════════════════════════════════════════════════════════════════
Extraction is SEMANTIC, not lexical. Your job is to understand the *role* every
piece of text plays in the document, even when the layout, header words, or
language are unfamiliar. The detailed synonym lists below are HINTS — they help
when present, but they are NOT exhaustive. If you encounter a label, layout or
language you have never seen before, infer the role from context (position,
neighbouring fields, value shape) and map it accordingly. NEVER refuse a row
or skip a field just because the header word is missing from the synonym list.

For ORDERS specifically, the three highest-priority fields are:
  1. customer_name  — the human/company that placed the order ("client name").
                      If you genuinely cannot identify a customer name, return
                      null (the UI will render a dash). NEVER substitute a PO
                      number, account code, phone, address, or "Sales Contact"
                      person in its place.
  2. line_items[].description / sku_name — the product / item name.
  3. line_items[].quantity — how many units of that item were ordered.

These three fields MUST be extracted regardless of the document's format,
language, currency, layout style (table, list, paragraph, hand-written,
WhatsApp-style "5 cases of X"), or column header wording. Use semantic cues:
  - A name-like string near "to / for / client / shop / store / restaurant /
    party / consignee / deliver to / shipping / customer / buyer" → customer_name.
  - A short integer/decimal next to a product description → quantity.
  - A descriptive phrase containing food/material/SKU words next to a quantity
    or price → item description.
You should be format-agnostic: a new vendor's layout must not require any
prompt change.

═══════════════════════════════════════════════════════════════════════════════
DETAILED SYNONYM HINTS (apply when matching labels are present)
═══════════════════════════════════════════════════════════════════════════════

CRITICAL HEADER / FIELD SYNONYMS — apply these mappings:

For LINE ITEMS, map these column headers:
  sku_code        ← "Product Code", "Item Code", "SKU", "SKU Code", "Product ID",
                    "Item ID", "Article No", "Part No", "Code", "Ref",
                    "Reference", "Material Code", "HSN", "ITEM" (when a separate
                    DESCRIPTION column exists alongside it — see two-column rule
                    below)
  description     ← "Description", "Particulars", "Details", "Goods", "Material",
                    "Article", "Product Description", or "Item" / "Product" /
                    "Product Name" / "Item Name" / "नाम" when there is no separate code
                    column
  sku_name        ← "Item Name" / "Product Name" / "नाम" when shown as its own column.
                    Otherwise auto-derive (see TWO-COLUMN ITEM+DESCRIPTION rule).
  quantity        ← "Qty", "Quantity", "Units", "Pcs", "PCS", "Nos", "Pieces",
                    "Shipped", "Ordered", "Cases", "Bottles", "Count", "मात्रा", "Qty." 
  unit_price      ← "Rate", "Price", "Unit Price", "Unit Cost", "MRP", "Per Unit",
                    "Cost". If the document has NO price column at all (only an
                    Amount/Total column alongside quantity), leave unit_price
                    null — the post-processor will derive it as line_total / qty.
  line_total      ← "Amount", "Total", "Line Total", "Extended", "Value", "Net Amount"
  unit_of_measure ← "UOM", "Unit", "Pack", "Per", e.g. "kg", "lbs", "gal", "case", "box"

LINE-ITEM COLUMN LAYOUT RULES — pick one based on the header row:

1) SINGLE-COLUMN layout (one cell holds code + name together, e.g.
   "DM-100 Dairy Milk Gallon"):
     - put the leading code-like token in sku_code
     - put the remaining text in description
     - sku_name = the full original cell text (code + " " + description)

2) SEPARATE ITEM + DESCRIPTION columns (very common on vendor invoices —
   applies whenever the header row contains BOTH an ITEM (or Item / Item No /
   Item Code / Product) column AND a DESCRIPTION (or Particulars / Goods)
   column, EVEN IF other columns sit between them. Examples:
     - Global Foods / House of Spices:
         "SN | ITEM | DESCRIPTION | UPC | SHIPPED | PRICE | AMOUNT"
     - Jersey Dairy Express:
         "ITEM | ADDS/CUTS | CASE/UNIT | DESCRIPTION | PCS | AMOUNT"
   Apply the same rule regardless of intermediate columns:
     - the ITEM column holds the SKU code (e.g. "1CUP4", "1030", "3000")
     - the DESCRIPTION column holds the human-readable product text
       (e.g. "LX. CUMIN POWDER 6X4 LB (NONGMO)", "GAL. HOMO",
       "QTS. HALF & HALF")
     - Map ITEM        → sku_code
     - Map DESCRIPTION → description
     - sku_name MUST be the concatenation: sku_code + " " + description
       (e.g. "1CUP4 LX. CUMIN POWDER 6X4 LB (NONGMO)",
       "1030 GAL. HOMO") so the data table's "Item Name" column shows
       the combined value.
     - The PCS / SHIPPED / Qty column → quantity.
     - If there is no price/rate column, leave unit_price null and let the
       post-processor derive it from AMOUNT / PCS.

3) NO-CODE layout (only a description / item-name column, no separate code):
     - sku_code = null
     - description = the cell text
     - sku_name   = same as description

OCR LINE-ITEM RECONSTRUCTION — read this carefully, the OCR output is messy:

The OCR engine reads top-to-bottom, left-to-right, so a single tabular row
often gets split across MANY physical text lines, AND barcode digits from a
"UPC BARCODE" column are frequently dumped on their OWN line (with spaces
between digits like "7 23 2 4 6 1 77472"). You MUST reassemble each logical
row before mapping it.

How to recognise the parts of one logical row in OCR text:
  - SN (row number)        — a small integer like "1", "2", "9", "10"
  - ITEM (sku_code)        — a short alphanumeric token (3–8 chars), often
                             mixed letters+digits, e.g. "1CUP4", "MZLY5",
                             "AAOR1", "7GV6", "LOGH6", "FRMO".
  - DESCRIPTION            — uppercase product text that may wrap onto 2–3
                             physical OCR lines (e.g.
                             "LX. SOUTH INDIAN RICE FLOUR 10X4" then "LB
                             (NONGMO)" on the next line — JOIN them).
  - UPC BARCODE            — long digit-only string (10–14 digits), often
                             printed with spaces, e.g. "841905080038" or
                             "7 23 2 4 6 1 77472". This is NOT description,
                             NOT sku_code, NOT quantity. IGNORE it (do not
                             put it in any field). Also do NOT confuse split
                             barcode digits like "5 5 2 7 0 0" with quantity.
  - SHIPPED / Qty          — small integer (1–999) appearing AFTER the
                             description and BEFORE the price.
  - PRICE                  — decimal number (e.g. 19.50, 32.00).
  - AMOUNT                 — decimal number, usually = qty × price.

Worked example for House of Spices "SN | ITEM | DESCRIPTION | UPC BARCODE |
SHIPPED | PRICE | AMOUNT" (this is the actual OCR text shape you will see):

    9
    MZLY5
    MAAZA LYCHEE (GL BTL) 12X330 ML
    5
    19.50
    97.50
    7 5 5 2 7 0 0 0 0 518          ← UPC barcode for row 9, IGNORE
    10
    7GV6
    LX. GREEN VATANA 10X4 LB
    5
    29.00
    145.00
    7 23 2 4 6 1 8 127 1           ← UPC barcode for row 10, IGNORE
    11
    AAOR1
    AASHIRVAAD ATTA 10X4 LB (EXPORT
    PACK)                          ← description wrapped, JOIN with line above
    841905080038                   ← UPC barcode for row 11, IGNORE
    25
    32.00
    800.00

Correct mapping for this block:
    {sku_code:"MZLY5", description:"MAAZA LYCHEE (GL BTL) 12X330 ML",
     sku_name:"MZLY5 MAAZA LYCHEE (GL BTL) 12X330 ML",
     quantity:5, unit_price:19.50, line_total:97.50}
    {sku_code:"7GV6",  description:"LX. GREEN VATANA 10X4 LB",
     sku_name:"7GV6 LX. GREEN VATANA 10X4 LB",
     quantity:5, unit_price:29.00, line_total:145.00}
    {sku_code:"AAOR1", description:"AASHIRVAAD ATTA 10X4 LB (EXPORT PACK)",
     sku_name:"AAOR1 AASHIRVAAD ATTA 10X4 LB (EXPORT PACK)",
     quantity:25, unit_price:32.00, line_total:800.00}

NEVER put a UPC barcode (a long digit-only string, with or without spaces
between digits) into description, sku_code, sku_name, or quantity. If the
only "description" you can find for a row is a digit string, that is a
barcode — re-scan the OCR text and find the actual product description (it
will be the uppercase alphabetic line(s) above or below it).

For VENDOR (the seller / supplier on an invoice), map these labels:
  vendor_name    ← "Vendor", "Supplier", "Sold By", "From", "Issued By", "Seller",
                   "Manufacturer", "Distributor", or the company name printed at the top
  vendor_address ← address block immediately under the vendor name
  vendor_gstin   ← "GST", "GSTIN", "Tax ID", "VAT", "EIN"
  vendor_email   ← any email address near the vendor block
  vendor_phone   ← any phone/fax near the vendor block

For BILL-TO (who is being billed on an invoice):
  bill_to_name    ← "Bill To", "Billed To", "Bill-To", "Invoice To", "Customer",
                    "Sold To", "Ship To" (only if no separate Ship-To exists),
                    "Delivery To", "Deliver To", "Delivered To" (when no other
                    customer/bill-to label exists — pick-ticket layouts use this
                    for the actual customer)
  bill_to_address ← address block under bill-to / delivery-to

For CUSTOMER (orders only — who placed the order):
  customer_name    ← "Customer", "Buyer", "Ordered By", "Client", "Account",
                     "Ship To Name", "Delivery To", "Deliver To", "Delivered To",
                     "Consignee", "End Customer"
  customer_code    ← "Customer ID", "Account No", "Customer Code"
  customer_email   ← email near customer block
  customer_phone   ← phone/mobile near customer block
  shipping_address ← "Ship To", "Deliver To", "Delivery Address", "Delivery To"
                     address block (the street/city portion under the customer name)

PICK-TICKET / DELIVERY-NOTE LAYOUT — read carefully:
Some documents (especially Sankaj-style pick tickets) print blocks labelled
  "DELIVERY TO"   → this is the CUSTOMER / BILL-TO (who receives the goods).
                    The first line is the customer name (e.g. "PA - BIRYANI &
                    BITES (MALVERN, PA) - NEW"). The following lines are the
                    shipping_address and customer_phone.
  "DELIVERY FROM" → this is the VENDOR / SUPPLIER (who is sending the goods).
                    Map the company name to vendor_name and the address to
                    vendor_address.
  "CUSTOMER PO#"  → this is an ORDER / PURCHASE ORDER NUMBER (e.g. "O260408D4X7EZ").
                    It is NEVER a customer_name. Map it to order_number (and to
                    invoice_number too if no other invoice number exists).
  "DELIVERY DATE" → delivery_date.
  "Sales Contact" → ignore for the schema (not stored separately) — never put it
                    into customer_name or vendor_name.

For HEADER FIELDS:
  invoice_number ← "Invoice #", "Invoice No", "Bill No", "Inv No", "Tax Invoice #"
  order_number   ← "Order #", "Order No", "PO #", "PO Number", "Purchase Order",
                   "Sales Order", "Customer PO", "Customer PO#", "Cust PO"
  invoice_date   ← "Invoice Date", "Bill Date", "Date", "Issued"
  order_date     ← "Order Date", "PO Date", "Ordered On"
  due_date       ← "Due Date", "Payment Due", "Pay By"
  delivery_date  ← "Delivery Date", "Ship Date", "Required By", "Requested Date"
  payment_terms  ← "Terms", "Payment Terms", "Net X", e.g. "Net 30", "Cash", "COD"

For AMOUNTS:
  subtotal        ← "Subtotal", "Sub-total", "Sum", "Goods Total"
  tax_amount      ← "Tax", "GST", "VAT", "Sales Tax"
  discount_amount ← "Discount", "Less", "Rebate"
  total_amount    ← "Total", "Grand Total", "Amount Due", "Balance Due", "Net Payable"

OUTPUT RULES:
- Return ONLY valid JSON. No markdown fences, no commentary outside the JSON.
- All money values must be plain numbers (no currency symbol, no commas, no spaces).
- All dates must be ISO format YYYY-MM-DD. If the year is 2-digit, assume 20XX.
- If a field is genuinely unknown / not present, return null. Do NOT guess.
- For document_type "order", populate customer_* and order_* fields, leave vendor_* / bill_to_* / invoice_* as null.
- For document_type "invoice" or "receipt", populate vendor_* / bill_to_* / invoice_* fields, leave customer_* / order_* as null.
- NEVER put a PO number, reference code, account number, date, or any
  alphanumeric ID into a *_name field (vendor_name, bill_to_name,
  customer_name). Name fields must contain a human/company name only. If you
  see a value like "O260408D4X7EZ", "PO12345", "REF-001" sitting under a
  "Customer" or "Bill To" label, that is a PO/reference number — map it to
  order_number, never to a name field.
- NEVER put a single short word fragment, a column header word ("ITEMS",
  "QTY", "TOTAL"), or a piece of an item description ("se", "tato", "ato")
  into order_number / invoice_number. If you cannot find a clear order
  number, return null and let the caller fall back to the filename.
- For a *_name field, the value MUST contain at least one alphabetic word of
  3+ letters and look like an actual person/company/shop name. Reject
  values that are pure numbers, single letters, or random fragments.
- "confidence" is your overall confidence 0.0-1.0 that the extraction is correct.
- "notes" is a short string (max 200 chars) explaining any tricky mappings you made, or null.

═══════════════════════════════════════════════════════════════════════════════
HANDWRITTEN / WHATSAPP-PHOTO ORDERS — SPECIAL HANDLING
═══════════════════════════════════════════════════════════════════════════════
Many orders arrive as photographs of handwritten lists from grocery / produce
shops (typical filename: "00007132-PHOTO-2026-04-23-22-02-08.jpg"). They are
often:
  - Pages from a notebook / order pad with no header at all.
  - A list of "<qty> <unit> <item>" lines — e.g. "4 Box Mango Atulfo",
    "2 Bag Red Onion 10 Lb", "Tomatoes Plum 1 Box", "5 Cases Mint".
  - Sometimes the customer / shop name is written at the top corner.
  - Sometimes the page has TWO columns of items — read the left column
    fully top-to-bottom first, then the right column.

For these handwritten orders apply these rules:

1. customer_name: only fill if the page clearly shows a shop / customer
   name (e.g. handwritten header "Bombay Sweets", "Patel Grocery"). If the
   only thing visible is items, leave customer_name null — DO NOT make up a
   name from an item or a place fragment. The caller will fall back to
   the WhatsApp sender / Drive filename.

2. order_number: handwritten lists usually don't have one. Leave null. The
   caller will derive it from the filename's leading numeric prefix.

3. order_date: only fill if a clear date is written on the page. If only the
   filename has the date, leave null and the caller will fall back to it.

4. line_items — THIS IS THE MOST IMPORTANT PART. Each handwritten line is
   typically "<quantity> <unit> <item description>" or
   "<item description> <quantity> <unit>". Examples:
     "4 Box Mango Atulfo"        → qty=4, uom="Box",  desc="Mango Atulfo"
     "2 Bag Red Onion 10 Lb"     → qty=2, uom="Bag",  desc="Red Onion 10 Lb"
     "Mint 5 Cases"              → qty=5, uom="Cases", desc="Mint"
     "Tomato Plum"               → qty=null,          desc="Tomato Plum"
                                   (no number visible — still record it)
   RULES for line_items on handwritten orders:
     a) Each visible item gets ITS OWN line_item entry. Do NOT concatenate
        multiple items into a single description — that produces giant
        useless rows. The data table renders one row per line_item, so an
        order of 30 items must produce 30 line_items, not 1 huge one.
     b) sku_name = description (no separate code column).
     c) sku_code = null (handwritten lists have no SKU codes).
     d) unit_price = null (handwritten lists rarely have prices).
     e) line_total = null (rarely shown).
     f) If a number is followed by a unit word (Box, Bag, Pcs, Cases,
        Bunches, Kg, Lb, Lbs, Bottles, LB, Bag, Bags, Tray, Pack), treat
        it as quantity + unit_of_measure.
     g) Numbers attached to weight (e.g. "10 Lb" inside "Red Onion 10 Lb
        Bag") are part of the description, not the quantity. The leading
        count ("2 Bag") is the quantity.
     h) Symbols like ✓ / ✗ / ① / ② before items are checkmarks — IGNORE
        them and still record the item.

5. line_items.quantity must be a NUMBER, not a unit word. If you cannot
   determine the quantity for an item, leave quantity null but still emit
   the line so the operator sees the item in the table.

═══════════════════════════════════════════════════════════════════════════════
CURSIVE / HARD-TO-READ HANDWRITING — ANTI-HALLUCINATION RULES
═══════════════════════════════════════════════════════════════════════════════
Cursive handwriting and dim photographs are common. The following rules are
ABSOLUTE — violating them produces wrong data the client will reject:

A. NEVER invent or guess a quantity. If a digit is unreadable, smudged,
   crossed out, or simply not present, set quantity = null. It is far better
   to have null quantities the operator can fill in than fake numbers like
   "1123", "27243", or "777195" that look real but are wrong.

B. Order quantities for produce / grocery / dairy almost ALWAYS sit in the
   range 1–500 (typical: 1–50). If your reading gives a number > 1000,
   double-check it visually — it is almost certainly wrong (a stray pen
   stroke or a unit-of-measure number bleeding in). When in doubt, set
   quantity = null. NEVER emit a quantity > 10000.

C. NEVER fabricate item descriptions. If a line is illegible, omit it
   entirely rather than emit a placeholder like "item", "unknown", "—",
   or a transliterated guess.

D. When deciphering cursive, use these visual cues:
   - Leading numbers in the left margin / before the item word are the
     quantity. They are usually 1–3 digits.
   - A short word (1-4 letters) right after the number is the unit
     (Box, Bag, Lb, Kg, Pc, Cs, Cases, Bunch, Bunches, Tray, Pkt, NOS).
   - Weight numbers INSIDE the item name (e.g. "Onion 10 Lb Bag") are
     part of the description, not the quantity.
   - Crossed-out numbers / words mean the line was cancelled — skip it.

E. If the photo is too blurry to read AT ALL, return an empty line_items
   array and notes = "image too blurry to read reliably". Do NOT pad the
   list with hallucinated entries.

F. The image you see and the OCR-text hint may disagree — TRUST THE IMAGE
   for handwritten content (OCR badly mangles cursive) but trust the OCR
   text for clearly printed digits / SKU codes.

═══════════════════════════════════════════════════════════════════════════════
FOOD / GROCERY / PRODUCE DOMAIN KNOWLEDGE — APPLY ALWAYS
═══════════════════════════════════════════════════════════════════════════════
This system processes orders for an Indian-American grocery / restaurant
supply business. The vast majority of items are FOOD — dairy, produce,
canned goods, dry goods, spices, frozen, beverages. You MUST recognise food
words as ITEM names even when the layout is unusual or the quantity is
blank.

Common item words you will see (treat ANY of these — and obvious variants —
as a line-item description, even on its own with no other label):

  Dairy / eggs:   Milk, Sour Cream, Yoghurt, Yogurt, Butter, Ghee, Paneer,
                  Heavy Cream, Heavy Whipping Cream, Half & Half, Cheese,
                  Cottage Cheese, Cream Cheese, Egg, Eggs

  Vegetables:     Onion(s), Red Onion, Yellow Onion, Tomato(es), Plum Tomato,
                  Potato(es), Cauliflower, Cabbage, Broccoli, Carrot, Beetroot,
                  Cucumber, Eggplant, Baby Eggplant, Bell Pepper (Yellow/Red/
                  Green), Chilly/Chilli (Green/Red), Okra/Bhindi/Desi Okra,
                  Spring Onion, Ginger, Garlic, Peeled Garlic, Mushroom,
                  Mushroom Button, Spinach, Baby Spinach, Banana Leaf,
                  Curry Leaves, Mint, Cilantro/Coriander, Lime, Lemon,
                  Fansi/Green Beans

  Fruits:         Mango, Raw Mango, Apple, Green Apple, Banana, Strawberry,
                  Pineapple, Pomegranate, Watermelon, Papaya, Lychee, Guava

  Frozen / canned: Frozen Coconut, Frozen Corn, Frozen Spinach, Frozen Mango,
                   Vadilal Frozen Mango, Canned Tomato (Whole/Puree/Paste),
                   Coconut Milk, Chaokah, Tomato Paste, Lemongrass, Jackfruit

  Dry / pantry:   All Purpose Flour, Atta, Rice (Basmati / Sona Masoori /
                  Daawat / Zeeba), Dal, Sugar, Salt, Salt Bag, Baking Soda,
                  Corn Starch, Vinegar (White), Mayonnaise/Mayonise, Vanilla
                  Essence/Essense, Paan Leaves, Dry Rose Petal, Celery Stick,
                  Butter Paper, Canola Oil, Fry Oil, Olive Oil

  Beverages / sweets: Maaza, Frooti, Lassi, Soda, Juice, Halwa, Burfi, Ladoo

Common UNIT words (these are NEVER items; they belong in unit_of_measure):
  Box, Bx, Bag, Bg, Case, Cs, Ct, Pack, Pkt, Pkg, Tray, Bunch, Bunches,
  Pc, Pcs, Pieces, NOS, Nos, No, Each, Ea, Bottle, Btl, Carton, Crate,
  Lb, Lbs, LB, Kg, Kgs, Gm, G, Oz, Gal, Gallon, Ltr, L, Ml, Doz, Dozen,
  B.K.T (Box-Kit), BKT

Domain-driven rules:
  i)  If you see a food word from (or similar to) the lists above, ALWAYS
      emit a line_item for it — even if the quantity is blank, illegible,
      a dash ("—"), an empty cell, or just a tick mark. Set quantity=null
      and unit_of_measure=null in that case. The operator will fill it in.
  ii) Conversely, if the only thing in a cell is a unit word (Box, Lb, Bag)
      with no number and no item nearby, IGNORE it — it is a column header
      or stray fragment, not an item.
  iii) Plural / singular variants are the same item ("Onion" vs "Onions",
       "Tomato" vs "Tomatoes"). Don't deduplicate, but treat them as items.

═══════════════════════════════════════════════════════════════════════════════
DOCUMENT HEADER / TITLE — NEVER A LINE ITEM
═══════════════════════════════════════════════════════════════════════════════
Every physical document has a printed title, label, or header at the top.
These are NOT line items. You MUST skip them.

Common examples of document titles that must NOT become line_items:
  - "Furnters Order 2026-04-29 Inventory List"
  - "INCOMING Orders List Scan 2026-04-23"
  - "Invoice #10001 - Global Foods"
  - "PURCHASE ORDER", "DELIVERY NOTE", "PICK LIST"
  - A shop or vendor name printed in the header/title area
  - A date printed as a standalone heading

Rules:
  A. If text at the top of the page (or the prominent title/heading area)
     looks like a document name, file label, or heading — SKIP IT entirely.
     Do NOT emit it as a line_item.
  B. A phrase that contains BOTH a 4-digit year (e.g. 2026) AND a
     document-type word (Order, Invoice, Inventory, List, Requisition,
     Purchase, Delivery, Scan, Note, Receipt) is a document header — SKIP IT.
  C. Text that looks like a filename (underscores between words, dashes in
     a YYYY-MM-DD date pattern, or mixed CamelCase with a date) is a
     document title — SKIP IT.
  D. Document titles are NEVER food items, products, or goods for sale.
     If you cannot find any real product line items, return an EMPTY
     line_items array rather than emitting the title as a fake item.
     An empty array is far more useful to the operator than a garbage row.

═══════════════════════════════════════════════════════════════════════════════
PRINTED REQUISITION / CHECKLIST FORMS (Sankaj-style "Dairy | Qty | Veg | Qty")
═══════════════════════════════════════════════════════════════════════════════
Many recurring customers send a PRINTED checklist form where:
  - The header row says "SANKAJ" (or another shop name) in the top cell.
  - The page is divided into TWO column pairs side-by-side:
        Column A: <Category> | Quantity     Column B: <Category> | Quantity
        (e.g. "Dairy | Qty"  and  "Vegetables & Fruits | Qty")
  - Inside each column pair, the LEFT cell contains a PRINTED item name
    (Milk, Sour Cream, Yoghurt, Cauliflower, Cilantro, Mint, ...).
  - The RIGHT cell contains a HANDWRITTEN quantity ("3 0", "1 Case",
    "2 B.K.T", "5 LB", "1 BOX", "10 LB", "4 BOX", "4 Case") OR is blank
    OR contains just a dash "—" / a wavy line / a tick.
  - Sub-headers like "Dairy", "Canned Fruit", "Other", "Vegetables &
    Fruits" mark a CATEGORY change. They are NOT items themselves — do not
    emit them as line_items, but DO emit every printed item that follows
    them, in order.

How to extract a Sankaj-style checklist correctly:

  1. customer_name = the shop name printed at the top (e.g. "SANKAJ").
     If no shop name is visible, leave null.

  2. order_number = null (these forms have no order number printed; the
     caller will derive one from the filename).

  3. line_items: emit ONE entry per printed item — in reading order, left
     column first then right column. For each:
       - description = the printed item name verbatim ("Milk",
         "Heavy Whipping Cream", "Mushroom Button", "Yellow Bell Pepper").
       - sku_name    = same as description.
       - quantity    = the handwritten number in the adjacent cell, parsed
         as a plain integer or decimal. If the cell is blank, dashes only,
         a tick, or completely illegible → quantity = null. Cross-check:
         food order quantities are almost always 1–500.
       - unit_of_measure = the unit word written next to the number
         ("Box", "BOX", "Case", "LB", "B.K.T", "Bag", "Pcs"). If only a
         number is written with no unit, set unit_of_measure=null.
       - sku_code = null, unit_price = null, line_total = null.

  4. Even items with NO handwritten quantity MUST appear in the output
     (with quantity=null). The whole point of the checklist is for the
     operator to see every available item — dropping unmarked rows
     defeats it. The operator will fill blanks downstream.

  5. NEVER merge multiple printed item names into a single description. A
     row like "All Purpose flour" is one item; "raw mango" is a separate
     item; "Salt Bag" is a separate item.

  6. If you see a token like "M-Z1" written next to "Mushroom Button",
     that is a vendor / brand code added by hand — append it to
     unit_of_measure or notes; do NOT use it as quantity.`;

function getApiKey(): string | null {
  return process.env.OPENROUTER_API_KEY || null;
}

function getPreferredModel(): string {
  return process.env.OPENROUTER_MODEL || FREE_MODEL_FALLBACK_CHAIN[0];
}

export function isLlmMapperAvailable(): boolean {
  return getApiKey() !== null;
}

export const EMPTY_LLM_DOC: MappedDocument = {
  invoice_number: null,
  order_number: null,
  invoice_date: null,
  order_date: null,
  due_date: null,
  delivery_date: null,
  payment_terms: null,
  currency: null,
  vendor_name: null,
  vendor_code: null,
  vendor_address: null,
  vendor_email: null,
  vendor_phone: null,
  vendor_gstin: null,
  bill_to_name: null,
  bill_to_address: null,
  customer_name: null,
  customer_code: null,
  customer_email: null,
  customer_phone: null,
  shipping_address: null,
  subtotal: null,
  tax_amount: null,
  discount_amount: null,
  total_amount: null,
  line_items: [],
  confidence: 0,
  notes: null,
};

/**
 * Heuristic: detects strings that look like a PO/reference/account code rather
 * than a human or company name (used to scrub *_name fields the LLM may have
 * mis-populated, e.g. when "Customer PO# O260408D4X7EZ" leaks into
 * customer_name on Sankaj-style pick tickets).
 */
function looksLikeCode(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  // Pure digits (account no, phone) → not a name
  if (/^\d[\d\s\-]*$/.test(v)) return true;
  // Alphanumeric blob with no spaces and at least one digit, ≥6 chars
  if (!/\s/.test(v) && /\d/.test(v) && v.length >= 6 && /^[A-Z0-9\-_]+$/i.test(v)) return true;
  // Starts with PO/REF/ORD prefix
  if (/^(po|ref|ord|inv|so|cust)[\s#:\-]*[A-Z0-9\-]+$/i.test(v)) return true;
  return false;
}

function scrubName(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (looksLikeCode(trimmed)) return null;
  return trimmed;
}

/**
 * Heuristic: strings that are too short / non-numeric / look like word
 * fragments to plausibly be a real order or invoice number. We strip these
 * because the LLM occasionally pulls fragments like "se", "tato", "ITEMS"
 * out of OCR text and stuffs them into order_number.
 */
function looksLikeJunkRefNumber(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  // Pure alphabetic and short — almost certainly a fragment
  if (/^[a-zA-Z]{1,5}$/.test(v)) return true;
  // Common header-row words leaking from OCR
  if (/^(items?|total|qty|date|order|po|amount|price|subtotal|tax|note|name)$/i.test(v)) return true;
  // Single non-alphanumeric char
  if (v.length < 3) return true;
  // Real order/invoice numbers always have at least one digit
  if (!/\d/.test(v)) return true;
  return false;
}

function scrubRefNumber(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (looksLikeJunkRefNumber(trimmed)) return null;
  return trimmed;
}

function normalise(raw: Partial<MappedDocument> | null | undefined): MappedDocument {
  const merged: MappedDocument = { ...EMPTY_LLM_DOC, ...(raw || {}) };
  if (!Array.isArray(merged.line_items)) merged.line_items = [];
  merged.line_items = merged.line_items.map((li, idx) => {
    // LLM may return numbers/objects for these fields — coerce to string|null.
    const toStr = (x: unknown): string | null => {
      if (x == null) return null;
      if (typeof x === 'string') return x;
      if (typeof x === 'number' || typeof x === 'boolean') return String(x);
      return null;
    };
    const sku_code_raw = toStr(li.sku_code);
    let description = toStr(li.description);
    let sku_name = toStr(li.sku_name);

    // Defensive: a value made up only of digits and spaces is a UPC/EAN
    // barcode that the LLM accidentally pulled into a text field. Drop it.
    const looksLikeBarcode = (v: string | null) =>
      !!v && /^[\d\s]{8,}$/.test(v.trim()) && /\d/.test(v);
    if (looksLikeBarcode(description)) description = null;
    if (looksLikeBarcode(sku_name)) sku_name = null;
    const sku_code = looksLikeBarcode(sku_code_raw) ? null : sku_code_raw;

    // Reject descriptions that look like document titles / file labels rather
    // than actual product names. Patterns seen in practice:
    //   "Furnters Order 2026 04 29 Inventory List"  ← vision model read title
    //   "2026-04-23_INCOMING_Orders_List_Scan"       ← filename leaked in
    // These are NEVER products. Nulling them lets the empty-item filter below
    // drop the row, or reveals a real sku_code if one exists alongside.
    const looksLikeDocumentTitle = (v: string | null): boolean => {
      if (!v) return false;
      const s = v.trim();
      if (s.length < 8) return false;
      // YYYY MM DD (space-separated date inside title) — "Order 2026 04 29 List"
      if (/\b20\d{2}\s+\d{2}\s+\d{2}\b/.test(s)) return true;
      // YYYY-MM-DD or YYYY_MM_DD pattern embedded in text
      if (/\b20\d{2}[-_]\d{2}[-_]\d{2}\b/.test(s)) return true;
      // Year + document-type phrase together — "2026 Inventory List", "Order List 2025"
      if (/\b20\d{2}\b/.test(s) && /\b(inventory[\s_-]*list|orders?[\s_-]*list|invoice[\s_-]*list|delivery[\s_-]*note|purchase[\s_-]*order|packing[\s_-]*list|order[\s_-]*list)\b/i.test(s)) return true;
      return false;
    };
    if (looksLikeDocumentTitle(description)) description = null;
    if (looksLikeDocumentTitle(sku_name)) sku_name = null;

    // Auto-derive sku_name (the "Item Name" data-table column) so it always
    // shows a useful value:
    //   - separate ITEM + DESCRIPTION columns → "<code> <description>"
    //   - description only                    → description
    //   - code only                           → code
    if (!sku_name) {
      if (sku_code && description) sku_name = `${sku_code} ${description}`.trim();
      else if (description) sku_name = description;
      else if (sku_code) sku_name = sku_code;
    }

    return {
      line_number: typeof li.line_number === 'number' ? li.line_number : idx + 1,
      description,
      sku_code,
      sku_name,
      unit_of_measure: li.unit_of_measure ?? null,
      quantity: (() => {
        // Anti-hallucination guard: vision models on cursive handwriting
        // sometimes invent absurd quantities (e.g. 27243, 777195). Real
        // produce/grocery orders are essentially always ≤ 5000 units.
        // Anything bigger is almost certainly fabricated — drop it so the
        // operator sees null (a clear "needs review") instead of fake data.
        if (typeof li.quantity !== 'number' || !Number.isFinite(li.quantity)) return null;
        if (li.quantity <= 0) return null;
        if (li.quantity > 10000) return null;
        return li.quantity;
      })(),
      unit_price: (() => {
        if (typeof li.unit_price === 'number' && li.unit_price > 0) return li.unit_price;
        // Derive unit_price = line_total / quantity when the document has no
        // price column (e.g. Jersey Dairy "ITEM | ADDS/CUTS | CASE/UNIT |
        // DESCRIPTION | PCS | AMOUNT" layout).
        const qty = typeof li.quantity === 'number' ? li.quantity : null;
        const tot = typeof li.line_total === 'number' ? li.line_total : null;
        if (qty && tot && qty !== 0) {
          return Math.round((tot / qty) * 10000) / 10000;
        }
        return null;
      })(),
      line_total: typeof li.line_total === 'number' ? li.line_total : null,
    };
  });

  // Drop fully-empty line items (no name, no description, no quantity) —
  // these are pure hallucinations the LLM occasionally pads its output with.
  merged.line_items = merged.line_items.filter((li) => {
    const hasName = !!(li.sku_name || li.description);
    const hasQty = li.quantity != null;
    return hasName || hasQty;
  });

  // Defensive scrub: rescue PO/code-shaped values that leaked into name fields.
  const origCustomer = merged.customer_name;
  const origBillTo = merged.bill_to_name;
  const origVendor = merged.vendor_name;
  merged.customer_name = scrubName(merged.customer_name);
  merged.bill_to_name = scrubName(merged.bill_to_name);
  merged.vendor_name = scrubName(merged.vendor_name);

  // Drop fragment-shaped order/invoice numbers ("se", "tato", "ITEMS").
  merged.order_number = scrubRefNumber(merged.order_number);
  merged.invoice_number = scrubRefNumber(merged.invoice_number);

  // If a name field looked like a PO code and we don't already have an
  // order_number, promote the rescued code into order_number.
  if (!merged.order_number) {
    const candidate =
      (origCustomer && looksLikeCode(origCustomer) && origCustomer.trim()) ||
      (origBillTo && looksLikeCode(origBillTo) && origBillTo.trim()) ||
      null;
    if (candidate) merged.order_number = candidate;
  }

  if (typeof merged.confidence !== 'number') merged.confidence = 0.5;
  return merged;
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  ocrText: string,
  documentType: 'invoice' | 'order' | 'receipt'
): Promise<{ ok: true; content: string } | { ok: false; status: number; error: string }> {
  // Truncate extremely long OCR to keep token usage bounded.
  const text = ocrText.length > 18000 ? ocrText.slice(0, 18000) : ocrText;

  const userPrompt = `Document type hint: ${documentType}

Raw OCR text follows between <<< and >>>:
<<<
${text}
>>>

Return a JSON object with all the schema fields described in the system prompt.`;

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: 4000,
  };

  let res: Response;
  try {
    res = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // OpenRouter recommends these headers for analytics
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Vanagrp Invoice Processor',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: errText.slice(0, 500) };
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return { ok: false, status: res.status, error: 'Empty response from model' };
  }
  return { ok: true, content };
}

/**
 * Extract structured data from raw OCR text using an LLM.
 * Tries the preferred model first, then falls back through the free model
 * chain on rate-limit (429) errors.
 *
 * Returns null on configuration error or hard API failure so callers can
 * fall back to the regex extractor.
 */
export async function mapDocumentWithLlm(
  ocrText: string,
  documentType: 'invoice' | 'order' | 'receipt' = 'invoice'
): Promise<MappedDocument | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('[llm-mapper] OPENROUTER_API_KEY not set — skipping');
    return null;
  }
  if (!ocrText || ocrText.trim().length < 10) {
    console.warn('[llm-mapper] OCR text too short — skipping');
    return null;
  }

  // Build the model chain: preferred first, then any others not equal to it.
  const preferred = getPreferredModel();
  const chain = [preferred, ...FREE_MODEL_FALLBACK_CHAIN.filter((m) => m !== preferred)];

  let lastError = '';
  for (const model of chain) {
    const result = await callOpenRouter(apiKey, model, ocrText, documentType);
    if (result.ok) {
      // Some models (e.g. gemma) wrap the JSON in code fences — strip them.
      const cleaned = result.content
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
      let parsed: Partial<MappedDocument>;
      try {
        parsed = JSON.parse(cleaned);
      } catch (err) {
        console.error(
          `[llm-mapper] JSON parse failed for model ${model}:`,
          err,
          cleaned.slice(0, 300)
        );
        lastError = `Invalid JSON from ${model}`;
        continue;
      }
      const normalised = normalise(parsed);
      // Attach which model was used in notes for debugging
      if (normalised.notes) {
        normalised.notes = `[${model}] ${normalised.notes}`;
      } else {
        normalised.notes = `[${model}] extraction succeeded`;
      }
      return normalised;
    }

    lastError = `${model} → ${result.status} ${result.error.slice(0, 120)}`;
    // Fall through on rate-limit / temporary errors AND on empty-response
    // (which several free models return intermittently when overloaded).
    const isEmptyResponse = result.error.startsWith('Empty response');
    if (
      !isEmptyResponse &&
      result.status !== 429 &&
      result.status !== 502 &&
      result.status !== 503
    ) {
      console.error(`[llm-mapper] non-retryable error: ${lastError}`);
      return null;
    }
    console.warn(`[llm-mapper] ${lastError} — trying next model`);
  }

  console.error(`[llm-mapper] all models failed. last error: ${lastError}`);
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// VISION (multimodal) extraction — used for image-based orders / invoices.
//
// Why: the OCR engine reads text top-to-bottom which destroys the layout of
// handwritten produce-shop orders ("4 Box Mango", "2 Bag Onion 10 Lb"…).
// Sending the raw image to a vision-capable LLM lets it SEE the layout,
// columns and handwriting and produce far better line-items than the
// regex extractor + text-only LLM can.
//
// Models: free vision-capable models on OpenRouter (gemini-2.0-flash-exp,
// llama-3.2-vision, qwen2-vl). We fall through them on rate-limit errors.
// ────────────────────────────────────────────────────────────────────────────

const SUPPORTED_VISION_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export function isVisionMimeSupported(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return SUPPORTED_VISION_MIME.has(mimeType.toLowerCase());
}

async function callOpenRouterVision(
  apiKey: string,
  model: string,
  imageDataUrl: string,
  ocrText: string,
  documentType: 'invoice' | 'order' | 'receipt'
): Promise<{ ok: true; content: string } | { ok: false; status: number; error: string }> {
  const ocrSnippet = ocrText.length > 8000 ? ocrText.slice(0, 8000) : ocrText;

  const userParts: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text:
`Document type hint: ${documentType}

You are looking at a photograph or scan of a ${documentType}. The image is the
authoritative source — read it carefully (including any handwriting). The
OCR text below is provided as a noisy hint and may have garbled handwriting,
out-of-order columns, or missing characters. Trust the image whenever it
disagrees with the OCR text.

OCR text hint (between <<< and >>>):
<<<
${ocrSnippet}
>>>

Return a JSON object with all the schema fields described in the system prompt.
Pay special attention to extracting EVERY visible item as its own line_item,
correctly populating sku_name (item description) and quantity for each.

Output ONLY the JSON object — no commentary, no markdown fences, no preamble.`,
    },
    {
      type: 'image_url',
      image_url: { url: imageDataUrl },
    },
  ];

  // NOTE: Many free vision models on OpenRouter (gemma-3, nemotron, etc.) do
  // NOT support response_format=json_object and will return HTTP 400. We rely
  // on the prompt to coerce JSON-only output and parse defensively below.
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userParts },
    ],
    temperature: 0.1,
    max_tokens: 6000,
  };

  let res: Response;
  try {
    res = await fetch(OPENROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Vanagrp Invoice Processor',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: errText.slice(0, 500) };
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return { ok: false, status: res.status, error: 'Empty response from model' };
  return { ok: true, content };
}

/**
 * Extract structured fields from an image (and the OCR text as a hint) using
 * a multimodal LLM. Returns null on hard failure so the caller can fall back
 * to the text-only mapper / regex extractor.
 *
 * imageBuffer should be the ORIGINAL (un-preprocessed) image — vision models
 * read colour photographs better than the binarised B/W version we feed to
 * Google Vision.
 */
export async function mapDocumentImageWithLlm(
  imageBuffer: Buffer,
  mimeType: string,
  ocrText: string,
  documentType: 'invoice' | 'order' | 'receipt' = 'order'
): Promise<MappedDocument | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('[llm-mapper:vision] OPENROUTER_API_KEY not set — skipping');
    return null;
  }
  if (!isVisionMimeSupported(mimeType)) {
    return null;
  }

  // Cap data-url size: free vision models choke on very large payloads.
  // ~4 MB after base64 ≈ ~3 MB raw. Larger photos get downscaled by the
  // caller (or we just accept the smaller size).
  const MAX_BYTES = 4 * 1024 * 1024;
  let buf = imageBuffer;
  if (buf.length > MAX_BYTES) {
    try {
      // Lazy import sharp so this module remains import-cheap at boot.
      const sharp = (await import('sharp')).default;
      // Higher resolution (2200px) preserves cursive-handwriting detail —
      // dropping to 1600 made tight loops in cursive blur into each other.
      buf = await sharp(buf).resize({ width: 2200, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    } catch (err) {
      console.warn('[llm-mapper:vision] image downscale failed, sending original:', err);
    }
  }

  const dataUrl = `data:${mimeType};base64,${buf.toString('base64')}`;

  const envOverride = process.env.OPENROUTER_VISION_MODEL;
  const chain = envOverride
    ? [envOverride, ...VISION_MODEL_FALLBACK_CHAIN.filter((m) => m !== envOverride)]
    : VISION_MODEL_FALLBACK_CHAIN.slice();

  let lastError = '';
  for (const model of chain) {
    const result = await callOpenRouterVision(apiKey, model, dataUrl, ocrText, documentType);
    if (result.ok) {
      const cleaned = result.content
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
      // Some vision models prepend chatter ("Here is the JSON:") even when
      // told not to. Extract the first {...} block as a fallback.
      const jsonText = (() => {
        try {
          JSON.parse(cleaned);
          return cleaned;
        } catch {
          const start = cleaned.indexOf('{');
          const end = cleaned.lastIndexOf('}');
          if (start >= 0 && end > start) return cleaned.slice(start, end + 1);
          return cleaned;
        }
      })();
      let parsed: Partial<MappedDocument>;
      try {
        parsed = JSON.parse(jsonText);
      } catch (err) {
        console.error(`[llm-mapper:vision] JSON parse failed for model ${model}:`, err, cleaned.slice(0, 300));
        lastError = `Invalid JSON from ${model}`;
        continue;
      }
      const normalised = normalise(parsed);
      normalised.notes = normalised.notes
        ? `[vision:${model}] ${normalised.notes}`
        : `[vision:${model}] extraction succeeded`;
      return normalised;
    }

    lastError = `${model} → ${result.status} ${result.error.slice(0, 120)}`;
    const isEmptyResponse = result.error.startsWith('Empty response');
    // Retry on 404 (model not available — try the next one), 400 (bad
    // request — sometimes a model rejects an image format we can fix by
    // moving on), and the standard rate-limit / 5xx codes.
    if (
      !isEmptyResponse &&
      result.status !== 404 &&
      result.status !== 429 &&
      result.status !== 400 &&
      result.status !== 502 &&
      result.status !== 503
    ) {
      console.error(`[llm-mapper:vision] non-retryable error: ${lastError}`);
      return null;
    }
    console.warn(`[llm-mapper:vision] ${lastError} — trying next vision model`);
  }

  console.error(`[llm-mapper:vision] all vision models failed. last error: ${lastError}`);
  return null;
}

