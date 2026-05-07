import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { fetchCustomers, fetchVendors, createSiloCustomer } from '@/lib/silo/client';

type SiloAddr = { city?: string; state?: string; post?: string; street1?: string };
type SiloEntry = { id: string; companyName: string; addresses: SiloAddr[] };

/**
 * Build name->candidates map. A single name may map to multiple Silo records
 * differing only by location — in that case we use address tokens to break
 * the tie.
 */
function buildLookupIndex(
  records: { id: string; companyName: string; legalName?: string | null; addresses?: SiloAddr[] }[]
): Map<string, SiloEntry[]> {
  const map = new Map<string, SiloEntry[]>();
  const push = (k: string, e: SiloEntry) => {
    const key = k.toLowerCase().trim();
    if (!key) return;
    const list = map.get(key) || [];
    if (!list.find(x => x.id === e.id)) list.push(e);
    map.set(key, list);
  };
  for (const r of records) {
    const entry: SiloEntry = {
      id: r.id,
      companyName: r.companyName,
      addresses: (r.addresses || []) as SiloAddr[],
    };
    push(r.companyName, entry);
    if (r.legalName) push(r.legalName, entry);
  }
  return map;
}

function normalize(s?: string | null): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Score a candidate's location against the local address text.
 * Higher score = better match. Returns 0 when nothing aligns.
 */
function scoreLocation(localAddr: string | null | undefined, addresses: SiloAddr[]): number {
  const local = normalize(localAddr);
  if (!local || addresses.length === 0) return 0;
  let best = 0;
  for (const a of addresses) {
    let score = 0;
    const tokens = [a.city, a.state, a.post, a.street1].filter(Boolean) as string[];
    for (const t of tokens) {
      const n = normalize(t);
      if (!n) continue;
      if (n.length >= 2 && local.includes(n)) {
        score += t === a.post ? 3 : t === a.city ? 2 : 1;
      }
    }
    if (score > best) best = score;
  }
  return best;
}

function pickByLocation(
  candidates: SiloEntry[],
  localAddr: string | null | undefined
): SiloEntry | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  let best: SiloEntry | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const s = scoreLocation(localAddr, c.addresses);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best ?? candidates[0];
}

/**
 * POST: Silo Lookup — match new orders/invoices customer/vendor names against Silo records
 * Called nightly (before 9pm) by cron or manually to prepare data for Silo import.
 * 
 * This endpoint:
 * 1. Fetches all customers & vendors from Silo
 * 2. Finds unmatched orders/invoices in our DB
 * 3. Fuzzy-matches customer_name/vendor_name to Silo records
 * 4. Updates orders/invoices with matched customer_code/vendor_code
 * 5. Marks matched records as ready_for_export
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createServiceRoleClient();

    // 1. Fetch Silo customers & vendors
    const [customerData, vendorData] = await Promise.all([
      fetchCustomers(500),
      fetchVendors(500),
    ]);

    // Build lookup indexes (name → candidates) so we can disambiguate by location.
    const customerIndex = buildLookupIndex(customerData.customers);
    const vendorIndex = buildLookupIndex(vendorData.vendors);

    // 2. Get unmatched orders (pending export, have customer_name but no customer_code)
    const { data: unmatchedOrders } = await supabase
      .from('orders')
      .select('id, customer_name, customer_code, billing_address, shipping_address, customer_phone, customer_email')
      .is('customer_code', null)
      .not('customer_name', 'is', null)
      .or('export_status.is.null,export_status.eq.pending');

    let ordersMatched = 0;
    let ordersUnmatched = 0;
    let customersCreated = 0;
    const unmatchedOrderNames: string[] = [];

    if (unmatchedOrders) {
      for (const order of unmatchedOrders) {
        const name = (order.customer_name || '').toLowerCase().trim();
        const localAddr = order.shipping_address || order.billing_address || null;
        const candidates = customerIndex.get(name) || findFuzzyCandidates(name, customerIndex);
        let match: SiloEntry | null = pickByLocation(candidates, localAddr);

        // If no match and auto-create is enabled, attempt to create the
        // customer in Silo so the next sync will link cleanly.
        if (!match) {
          const created = await createSiloCustomer({
            companyName: order.customer_name || '',
            address: order.billing_address || order.shipping_address || null,
            phone: order.customer_phone || null,
            email: order.customer_email || null,
          });
          if (created) {
            const entry: SiloEntry = { id: created.id, companyName: created.companyName, addresses: [] };
            match = entry;
            customerIndex.set(name, [entry]);
            customersCreated++;
          }
        }

        if (match) {
          await supabase
            .from('orders')
            .update({ customer_code: match.id } as any)
            .eq('id', order.id);
          ordersMatched++;
        } else {
          ordersUnmatched++;
          unmatchedOrderNames.push(order.customer_name || '');
        }
      }
    }

    // 3. Get unmatched invoices (pending export, have vendor_name but no vendor_code)
    const { data: unmatchedInvoices } = await supabase
      .from('invoices')
      .select('id, vendor_name, vendor_code, vendor_address, bill_to_address')
      .is('vendor_code', null)
      .not('vendor_name', 'is', null)
      .not('vendor_name', 'in', '("Sankaj","Supply Seva")')
      .or('export_status.is.null,export_status.eq.pending');

    let invoicesMatched = 0;
    let invoicesUnmatched = 0;
    const unmatchedInvoiceVendors: string[] = [];

    if (unmatchedInvoices) {
      for (const inv of unmatchedInvoices) {
        const name = (inv.vendor_name || '').toLowerCase().trim();
        const localAddr =
          (inv as any).vendor_address || (inv as any).bill_to_address || null;
        const candidates = vendorIndex.get(name) || findFuzzyCandidates(name, vendorIndex);
        const match = pickByLocation(candidates, localAddr);
        if (match) {
          await supabase
            .from('invoices')
            .update({ vendor_code: match.id } as any)
            .eq('id', inv.id);
          invoicesMatched++;
        } else {
          invoicesUnmatched++;
          unmatchedInvoiceVendors.push(inv.vendor_name || '');
        }
      }
    }

    // 4. Mark validated + matched records as ready_for_export.
    //    These are the "clean" records that the operator can post to Silo via
    //    the "Post Approved to Silo" button (which exports with TEST_DATE
    //    1000-01-01 stamped on each row for the trial run).
    await supabase
      .from('orders')
      .update({ export_status: 'pending' } as any)
      .eq('validation_status', 'passed')
      .not('customer_code', 'is', null)
      .is('export_status', null);

    await supabase
      .from('invoices')
      .update({ export_status: 'pending' } as any)
      .eq('validation_status', 'passed')
      .not('vendor_code', 'is', null)
      .not('vendor_name', 'in', '("Sankaj","Supply Seva")')
      .is('export_status', null);

    // 5. Count how many records are now clean & ready for the test post.
    const [readyOrders, readyInvoices] = await Promise.all([
      supabase.from('orders').select('id', { count: 'exact', head: true }).eq('export_status', 'pending').eq('validation_status', 'passed'),
      supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('export_status', 'pending').eq('validation_status', 'passed'),
    ]);

    return NextResponse.json({
      status: 'ok',
      siloCustomers: customerData.customers.length,
      siloVendors: vendorData.vendors.length,
      orders: { matched: ordersMatched, unmatched: ordersUnmatched, unmatchedNames: unmatchedOrderNames },
      invoices: { matched: invoicesMatched, unmatched: invoicesUnmatched, unmatchedNames: unmatchedInvoiceVendors },
      customersCreated,
      readyForExport: {
        orders: readyOrders.count ?? 0,
        invoices: readyInvoices.count ?? 0,
        testDate: '1000-01-01',
        note: 'Use POST /api/export/silo with { mode: "test_approved" } to publish approved clean records using the Test Date.',
      },
    });
  } catch (err) {
    console.error('Silo lookup error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}

/** GET: Check status of Silo lookup readiness */
export async function GET() {
  try {
    const supabase = createServiceRoleClient();

    const [ordersReady, invoicesReady, ordersUnmatched, invoicesUnmatched] = await Promise.all([
      supabase.from('orders').select('id', { count: 'exact', head: true }).eq('export_status', 'pending'),
      supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('export_status', 'pending'),
      supabase.from('orders').select('id', { count: 'exact', head: true }).is('customer_code', null).not('customer_name', 'is', null),
      supabase.from('invoices').select('id', { count: 'exact', head: true }).is('vendor_code', null).not('vendor_name', 'is', null),
    ]);

    return NextResponse.json({
      ordersReadyForExport: ordersReady.count ?? 0,
      invoicesReadyForExport: invoicesReady.count ?? 0,
      ordersNeedingMatch: ordersUnmatched.count ?? 0,
      invoicesNeedingMatch: invoicesUnmatched.count ?? 0,
    });
  } catch (err) {
    console.error('Silo lookup status error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}

/**
 * Simple fuzzy match: returns ALL candidates whose key contains the search
 * term (or vice-versa) so the caller can disambiguate by location.
 */
function findFuzzyCandidates(
  search: string,
  map: Map<string, SiloEntry[]>
): SiloEntry[] {
  if (!search || search.length < 3) return [];

  const seen = new Set<string>();
  const out: SiloEntry[] = [];

  // Exact substring match
  for (const [key, vals] of Array.from(map.entries())) {
    if (key.includes(search) || search.includes(key)) {
      for (const v of vals) {
        if (!seen.has(v.id)) { seen.add(v.id); out.push(v); }
      }
    }
  }

  if (out.length > 0) return out;

  // Prefix match (first 8 chars)
  const prefix = search.slice(0, Math.min(search.length, 8));
  for (const [key, vals] of Array.from(map.entries())) {
    if (key.startsWith(prefix)) {
      for (const v of vals) {
        if (!seen.has(v.id)) { seen.add(v.id); out.push(v); }
      }
    }
  }
  return out;
}
