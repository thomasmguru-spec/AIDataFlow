import { NextRequest, NextResponse } from 'next/server';
import { Twilio } from 'twilio';
import { performOcr } from '@/lib/ocr/google-vision';
import { preprocessImage } from '@/lib/processing/preprocessor';

export const maxDuration = 60;
// Reads request query params (limit, ocr) — must NOT be statically rendered.
export const dynamic = 'force-dynamic';

interface WhatsAppItem {
  itemName: string;
  quantity: string;
}

interface WhatsAppMessage {
  sid: string;
  from: string;
  to: string;
  body: string;
  dateSent: string;
  direction: string;
  status: string;
  numMedia: number;
  mediaUrls: string[];
  items: WhatsAppItem[];
  ocrText: string | null;
  profileName: string | null;
  nameAndLocation: string | null;
}

const UNIT_RE = /\b(kg|g|gram|grams|lbs?|lb|pounds?|box|boxes|pcs?|pieces?|dozen|doz|case|cases|ctn|carton|cartons|bundle|bundles|bag|bags|pack|packs|unit|units|tray|trays|litre|liter|litres|liters|l|ml|gal|gallon|gallons)\b/i;

/**
 * Returns true when a line strongly resembles an item line. Strict mode:
 * the line MUST contain an explicit unit of measure to qualify. Used to
 * decide whether to treat the first message line as nameAndLocation or
 * as an item.
 */
function looksLikeItemLine(line: string): boolean {
  // Only lines that contain BOTH a number AND a unit qualify as items
  if (!UNIT_RE.test(line)) return false;
  return /\d/.test(line);
}

/**
 * Extract the first line as the client name/location ONLY when it does not
 * look like an item line.  If the first line IS an item, all lines are passed
 * to extractItems so no product data is lost.
 */
function extractNameAndLocation(text: string): { nameAndLocation: string | null; remainingText: string } {
  if (!text || !text.trim()) return { nameAndLocation: null, remainingText: text };

  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { nameAndLocation: null, remainingText: text };

  // If the first line looks like a product/item, don't steal it as a header
  if (looksLikeItemLine(lines[0])) {
    return { nameAndLocation: null, remainingText: lines.join('\n') };
  }

  return { nameAndLocation: lines[0], remainingText: lines.slice(1).join('\n') };
}

/**
 * Returns true if a line looks like metadata (phone, email, postal code, etc.)
 * and should never be treated as a product line.
 */
function isMetadataLine(line: string): boolean {
  // Explicit metadata labels: "Phone:", "Mob:", "Mobile:", "Tel:", "Contact:", "Address:", "Name:", "Email:", "WhatsApp:"
  if (/^(phone|mob|mobile|tel|telephone|contact|addr|address|name|email|whatsapp|wa|fax)\s*[:\s]/i.test(line)) return true;
  // Phone numbers: optional +/( prefix, then digit-heavy (7+ significant digits)
  if (/^[\+\(]?\d[\d\s\-\(\)\.]{6,}$/.test(line)) return true;
  // Lines that are purely digits (PIN codes, order IDs, account numbers)
  if (/^\d+$/.test(line)) return true;
  // Email addresses
  if (/@/.test(line)) return true;
  // Any text followed by a separator (space/colon/comma) then 5+ consecutive digits
  // Catches: "Phone: 9876543210", "Mob 9876543210", "Mumbai 400001", "Shop 5, Pin 400001"
  if (/^[a-zA-Z\s,\.\-\/]+[\s:,]+\d{5,}\s*$/.test(line)) return true;
  // Line contains 7+ consecutive digits anywhere → phone number embedded
  if (/\d{7,}/.test(line)) return true;
  // URL-like
  if (/https?:\/\//.test(line)) return true;
  return false;
}

/**
 * Returns true if a string is a valid product item name:
 *   - starts with a letter
 *   - is at least 2 characters long
 *   - contains at least one alphabetic word of 2+ chars (rejects '+91', 'A1', etc.)
 *   - is not entirely digits/symbols
 *   - is not a known metadata label (Phone, Address, Name, etc.)
 */
function isValidItemName(name: string): boolean {
  const trimmed = (name || '').trim();
  if (trimmed.length < 2) return false;
  if (!/^[a-zA-Z]/.test(trimmed)) return false;
  if (/^[\d\s\+\-\(\)\.]+$/.test(trimmed)) return false;
  // Reject names that are themselves a metadata label
  if (/^(phone|mob|mobile|tel|telephone|contact|addr|address|name|email|whatsapp|wa|fax|from|to|sender|customer|client|location|city|state|pin|pincode|zip)$/i.test(trimmed)) return false;
  // Must contain at least one word of 2+ alphabetic characters
  if (!/[a-zA-Z]{2,}/.test(trimmed)) return false;
  return true;
}

const UNIT_PATTERN =
  'kg|g|gram|grams|lbs?|lb|pounds?|box|boxes|pcs?|pieces?|dozen|doz|case|cases|ctn|carton|cartons|bundle|bundles|bag|bags|pack|packs|unit|units|tray|trays|litre|liter|litres|liters|l|ml|gal|gallon|gallons';

/**
 * Extract item name and quantity from text. Strict mode: every line MUST
 * contain BOTH a numeric quantity AND an explicit unit of measure to be
 * accepted as a product line. Anything else (bare names, names with random
 * numbers, addresses, phone numbers, greetings) is discarded.
 *
 * Accepted formats:
 *   - "10 kg Tomato"     (qty + unit + name)
 *   - "Tomato 10 kg"     (name + qty + unit)
 *   - "Tomato - 10 kg"   (name + separator + qty + unit)
 *   - "Tomato x 10 kg"   (name × qty + unit)
 */
function extractItems(text: string): WhatsAppItem[] {
  if (!text || !text.trim()) return [];

  const items: WhatsAppItem[] = [];
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Skip greeting / filler lines
    if (/^(hi|hello|hey|good\s*(morning|evening|afternoon)|thanks|thank you|ok|please|pls|bhai|sir|ji|order|send|bhej|de do|kar do)/i.test(line)) {
      continue;
    }

    // Skip any line that looks like metadata (phone, email, PIN code, URL, etc.)
    if (isMetadataLine(line)) continue;

    // ── Pattern A: "10 kg Tomato" — qty + UNIT (required) + name ──────────
    const pA = line.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})\\s+(.+)$`, 'i'));
    if (pA) {
      const itemName = pA[3].replace(/[-:=,]+$/, '').trim();
      if (isValidItemName(itemName)) {
        items.push({ quantity: `${pA[1]} ${pA[2]}`, itemName });
        continue;
      }
    }

    // ── Pattern B: "Tomato 10 kg" — name + qty + UNIT (required) ──────────
    const pB = line.match(new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})\\s*$`, 'i'));
    if (pB) {
      const itemName = pB[1].replace(/[-:=,]+$/, '').trim();
      if (isValidItemName(itemName)) {
        items.push({ itemName, quantity: `${pB[2]} ${pB[3]}` });
        continue;
      }
    }

    // ── Pattern C: "Tomato - 10 kg" — name separator qty + UNIT (required) ─
    const pC = line.match(new RegExp(`^(.+?)\\s*[-:=]+\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})\\s*$`, 'i'));
    if (pC) {
      const itemName = pC[1].trim();
      if (isValidItemName(itemName)) {
        items.push({ itemName, quantity: `${pC[2]} ${pC[3]}` });
        continue;
      }
    }

    // ── Pattern D: "Tomato x 10 kg" — name × qty + UNIT (required) ─────────
    const pD = line.match(new RegExp(`^(.+?)\\s*[xX×]\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})\\s*$`, 'i'));
    if (pD) {
      const itemName = pD[1].trim();
      if (isValidItemName(itemName)) {
        items.push({ itemName, quantity: `${pD[2]} ${pD[3]}` });
        continue;
      }
    }

    // No fallback — lines without an explicit unit (e.g. "Atul 5",
    // "Mumbai 400001", "10 Atul") are discarded entirely. This guarantees
    // the Item Name and Quantity columns only contain valid product data.
  }

  return items;
}

export async function GET(req: NextRequest) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const whatsappNumber = process.env.TWILIO_WHATSAPP_NUMBER;

    if (!accountSid || !authToken || !whatsappNumber) {
      return NextResponse.json(
        { error: 'Twilio credentials not configured' },
        { status: 500 }
      );
    }

    const client = new Twilio(accountSid, authToken);
    const { searchParams } = req.nextUrl;
    const limit = Math.min(Number(searchParams.get('limit') || '100'), 500);
    const processOcr = searchParams.get('ocr') !== 'false';

    // Fetch messages sent TO our WhatsApp number (inbound)
    const fromNumber = whatsappNumber.startsWith('whatsapp:')
      ? whatsappNumber
      : `whatsapp:${whatsappNumber}`;

    // Fetch inbound messages (customers sending to us)
    const inboundMessages = await client.messages.list({
      to: fromNumber,
      limit,
    });

    const results: WhatsAppMessage[] = [];

    for (const msg of inboundMessages) {
      let ocrText: string | null = null;
      let items: WhatsAppItem[] = [];
      const mediaUrls: string[] = [];

      // Extract name/location from first line, then parse items from remainder
      let nameAndLocation: string | null = null;
      if (msg.body) {
        const extracted = extractNameAndLocation(msg.body);
        nameAndLocation = extracted.nameAndLocation;
        items = extractItems(extracted.remainingText);
      }

      // Handle media (images) - download and OCR
      const numMedia = parseInt(msg.numMedia || '0', 10);
      if (numMedia > 0 && processOcr) {
        try {
          // Fetch media list for this message
          const mediaList = await client.messages(msg.sid).media.list();

          for (const media of mediaList) {
            const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${msg.sid}/Media/${media.sid}`;
            mediaUrls.push(mediaUrl);

            // Only OCR image types
            const ct = media.contentType || '';
            if (ct.startsWith('image/')) {
              try {
                const mediaRes = await fetch(mediaUrl, {
                  headers: {
                    Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
                  },
                  redirect: 'follow',
                });

                if (mediaRes.ok) {
                  const buffer = Buffer.from(await mediaRes.arrayBuffer());

                  // Preprocess image for better OCR
                  let processedBuffer: Buffer = buffer;
                  try {
                    const result = await preprocessImage(buffer, ct);
                    processedBuffer = Buffer.from(result.buffer);
                  } catch {
                    // Use original if preprocessing fails
                  }

                  const ocrResult = await performOcr(processedBuffer, ct);
                  if (ocrResult.fullText) {
                    ocrText = ocrResult.fullText;
                    // Extract items from OCR text
                    const ocrItems = extractItems(ocrResult.fullText);
                    if (ocrItems.length > 0) {
                      items = [...items, ...ocrItems];
                    }
                  }
                }
              } catch (ocrErr) {
                console.error(`OCR failed for media ${media.sid}:`, ocrErr);
              }
            }
          }
        } catch (mediaErr) {
          console.error(`Media fetch failed for message ${msg.sid}:`, mediaErr);
        }
      }

      results.push({
        sid: msg.sid,
        from: msg.from?.replace('whatsapp:', '') || '',
        to: msg.to?.replace('whatsapp:', '') || '',
        body: msg.body || '',
        dateSent: msg.dateSent?.toISOString() || msg.dateCreated?.toISOString() || '',
        direction: msg.direction || '',
        status: msg.status || '',
        numMedia,
        mediaUrls,
        items,
        ocrText,
        profileName: null,
        nameAndLocation,
      });
    }

    // Sort by date descending
    results.sort((a, b) => new Date(b.dateSent).getTime() - new Date(a.dateSent).getTime());

    return NextResponse.json({
      data: results,
      total: results.length,
    });
  } catch (err) {
    console.error('WhatsApp messages API error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch WhatsApp messages' },
      { status: 500 }
    );
  }
}
