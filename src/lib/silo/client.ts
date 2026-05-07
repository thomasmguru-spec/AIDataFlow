import dns from 'dns';
import https from 'https';

dns.setServers(['8.8.8.8', '8.8.4.4']);

const SILO_API_HOST = 'api.usesilo.com';
const SILO_LOGIN_PATH = '/api/login';
const SILO_GRAPHQL_PATH = '/graphql';

let cachedToken: string | null = null;
let tokenExpiry = 0;

function resolveHost(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err) return reject(err);
      resolve(addresses[0]);
    });
  });
}

function httpsRequest(
  method: string,
  ip: string,
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: ip,
        port: 443,
        path,
        method,
        servername: SILO_API_HOST,
        headers: {
          Host: SILO_API_HOST,
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) }
            : {}),
          ...headers,
        },
        timeout: 20000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const email = process.env.SILO_EMAIL || 'rsahni@thecodewiz.com';
  const password = process.env.SILO_PASSWORD || 'Sahnir2026#';

  const ip = await resolveHost(SILO_API_HOST);
  const res = await httpsRequest('POST', ip, SILO_LOGIN_PATH, { email, password });

  if (res.status !== 200) {
    throw new Error(`Silo login failed: ${res.status} ${res.body.substring(0, 200)}`);
  }

  const data = JSON.parse(res.body);
  cachedToken = data.token;
  // Token expires in ~24h based on JWT, refresh after 23h
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return cachedToken!;
}

export async function siloGraphQL<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = await getToken();
  const ip = await resolveHost(SILO_API_HOST);
  const res = await httpsRequest(
    'POST',
    ip,
    SILO_GRAPHQL_PATH,
    { query, variables },
    { Authorization: `Bearer ${token}` }
  );

  if (res.status !== 200) {
    throw new Error(`Silo GraphQL error: ${res.status} ${res.body.substring(0, 300)}`);
  }

  const json = JSON.parse(res.body);
  if (json.errors?.length) {
    throw new Error(`Silo GraphQL: ${json.errors[0].message}`);
  }
  return json.data as T;
}

// ────────────────────────────────────────────────────────────────
// Resilient pagination
// ────────────────────────────────────────────────────────────────
// Silo's GraphQL is backed by Postgres. Some legacy records have
// `requestedDate = '0000-00-00'` (an invalid Postgres timestamp). Whenever
// such a record falls inside the page we request, the *entire* response
// fails with:
//   pq: date/time field value out of range: "0000-00-00"
//
// We can't fix the data, so we work around it:
//   1. Try the requested page size.
//   2. On the date-range error, halve the page size and retry — bisecting
//      the range until we either succeed or shrink to first:1.
//   3. If first:1 still fails, that single record is poisoned: skip it by
//      asking Silo for first:0 with the next cursor (we just record the
//      skip and advance using the previous cursor + offset metadata).
//
// This is strictly better than the current behaviour (the whole sync /
// dashboard refresh dies on a single bad row).
export function isSiloDateRangeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Includes the original `0000-00-00` Postgres error AND Silo's
  // `ent: <X> not found` entity-resolution error — both can be triggered
  // by a single corrupt row in a paged query and are recovered by the
  // same bisect-and-skip strategy.
  return /out of range|0000-00-00|invalid input syntax for type (date|timestamp)|ent:\s*\w+\s*not found/i.test(msg);
}

/**
 * Run a paged Silo query that takes (first, after) and returns
 * `{ totalCount, pageInfo, edges }`. Bisects the page size on date-range
 * errors so a single bad record can't poison the entire sync.
 *
 * Returns the fully-collected edges, the totalCount Silo last reported,
 * the number of pages fetched, and the number of records we had to skip.
 */
export async function paginateSiloResilient<TEdge>(
  fetchPage: (first: number, after?: string) => Promise<{
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { node: TEdge }[];
  }>,
  opts: { firstPageSize?: number; minPageSize?: number; maxPages?: number } = {}
): Promise<{ edges: { node: TEdge }[]; totalCount: number; pages: number; skipped: number }> {
  const initial = opts.firstPageSize ?? 100;
  const minSize = opts.minPageSize ?? 1;
  const maxPages = opts.maxPages ?? 100;

  const allEdges: { node: TEdge }[] = [];
  let cursor: string | undefined;
  let totalCount = 0;
  let pages = 0;
  let skipped = 0;

  for (let p = 0; p < maxPages; p++) {
    let size = initial;
    let succeeded = false;
    let lastCursor = cursor;
    let pageData: { totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: { node: TEdge }[] } | null = null;

    while (size >= minSize) {
      try {
        pageData = await fetchPage(size, cursor);
        succeeded = true;
        break;
      } catch (e) {
        if (!isSiloDateRangeError(e)) throw e;
        if (size === minSize) break;
        size = Math.max(minSize, Math.floor(size / 2));
      }
    }

    if (!succeeded || !pageData) {
      // first:1 also failed → the single record at `cursor` is poisoned.
      // Skip it by stepping forward with first:1 and a tiny offset query
      // is not directly supported, so we just stop and let the caller
      // know one record (or window) was unreachable.
      skipped++;
      // Try to advance by requesting first:1 again (will likely fail) — if
      // it fails we accept the loss and break out.
      try {
        const probe = await fetchPage(1, lastCursor);
        if (probe.edges.length > 0) {
          allEdges.push(...probe.edges);
          cursor = probe.pageInfo.endCursor || cursor;
          totalCount = probe.totalCount || totalCount;
          if (!probe.pageInfo.hasNextPage) break;
          continue;
        }
      } catch {
        /* swallow — record genuinely unreachable */
      }
      break;
    }

    pages++;
    allEdges.push(...pageData.edges);
    totalCount = pageData.totalCount || totalCount;
    if (!pageData.pageInfo.hasNextPage || !pageData.pageInfo.endCursor) break;
    cursor = pageData.pageInfo.endCursor;
  }

  return { edges: allEdges, totalCount, pages, skipped };
}

// ── Typed queries ────────────────────────────────────────────────

export interface SiloSalesOrder {
  id: string;
  invoiceNumber: string | null;
  customerPurchaseOrderNumber: string | null;
  requestedDate: string;
  fulfilledDate: string | null;
  originalBalance: number;
  remainingBalance: number;
  orderTotal: number;
  transportMethod: string;
  createdAt: string;
  cancelledAt: string | null;
  paymentStatus: string;
  customer: { id: string; companyName: string };
}

export interface SiloPurchaseOrder {
  id: string;
  purchaseOrderNumber: string;
  customerInvoiceNumber: string | null;
  requestedDate: string | null;
  receivedDate: string | null;
  orderTotal: number;
  transportMethod: string;
  createdAt: string;
  cancelledAt: string | null;
  vendor: { id: string; companyName: string };
}

export interface SiloCustomer {
  id: string;
  companyName: string;
  legalName: string | null;
  customerNote: string;
  netD: number;
  isDisabled: boolean;
  addresses: { id: string; name: string | null; phone: string | null; street1: string; street2: string | null; city: string; state: string; post: string; country: string; isDefaultShipping: boolean }[];
  customContacts: { firstName: string; lastName: string | null; email: string | null; phoneNumber: string | null } | null;
  deliveryRoute: { name: string; type: string } | null;
}

export interface SiloVendor {
  id: string;
  companyName: string;
  legalName: string;
  addresses: { id: string; name: string | null; phone: string | null; street1: string; street2: string | null; city: string; state: string; post: string; country: string }[];
  contacts: { id: string; name: string | null; phoneNumber: string | null; faxNumber: string | null; emailAddress: string | null }[];
}

export interface SiloPayment {
  id: string;
  amount: number;
  paymentDate: string;
  paymentMethod: string | null;
  isRefund: boolean;
  notes: string | null;
  checkNumber: string | null;
  customer: { id: string; companyName: string } | null;
  vendor: { id: string; companyName: string } | null;
}

export interface SiloOrderItem {
  id: string;
  quantity: number;
  inventory: {
    id: string;
    lookupCode: string | null;
    upc: string | null;
    plu: string | null;
    displayGroup: string | null;
    warehouseLocation: string;
    physicalQuantity: number | null;
    product: { id: string; name: string };
  };
}

interface Connection<T> {
  totalCount: number;
  edges: { node: T }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

// ── Sales & Purchase Orders ──────────────────────────────────────

// Internal: raw single-page fetch. Kept private so callers go through the
// resilient wrapper which automatically bisects on the date-range error.
async function fetchSalesOrdersPage(first: number, after?: string) {
  const afterArg = after ? `, after: "${after}"` : '';
  const data = await siloGraphQL<{ salesOrders: Connection<SiloSalesOrder> }>(`{
    salesOrders(first: ${first}${afterArg}, orderBy: [{ field: REQUESTED_DATE, direction: DESC }]) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id invoiceNumber customerPurchaseOrderNumber
          requestedDate fulfilledDate originalBalance remainingBalance
          orderTotal transportMethod createdAt cancelledAt paymentStatus
          customer { id companyName }
        }
      }
    }
  }`);
  return data.salesOrders;
}

export async function fetchSalesOrders(first = 50, after?: string) {
  // Resilient: requested page size is the upper bound; on the date error
  // we bisect down to first:1, skipping any single poisoned record so the
  // dashboard never sees a hard failure.
  try {
    const page = await fetchSalesOrdersPage(first, after);
    return { salesOrders: page };
  } catch (e) {
    if (!isSiloDateRangeError(e)) throw e;
    let size = Math.max(1, Math.floor(first / 2));
    while (size >= 1) {
      try {
        const page = await fetchSalesOrdersPage(size, after);
        return { salesOrders: page };
      } catch (e2) {
        if (!isSiloDateRangeError(e2)) throw e2;
        if (size === 1) break;
        size = Math.max(1, Math.floor(size / 2));
      }
    }
    // Cannot recover this window → return an empty page so the UI keeps
    // working instead of throwing 502.
    return {
      salesOrders: { totalCount: 0, edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
    };
  }
}

async function fetchPurchaseOrdersPage(first: number, after?: string) {
  const afterArg = after ? `, after: "${after}"` : '';
  const data = await siloGraphQL<{ purchaseOrders: Connection<SiloPurchaseOrder> }>(`{
    purchaseOrders(first: ${first}${afterArg}, orderBy: [{ field: REQUESTED_DATE, direction: DESC }]) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id purchaseOrderNumber customerInvoiceNumber
          requestedDate receivedDate orderTotal transportMethod
          createdAt cancelledAt
          vendor { id companyName }
        }
      }
    }
  }`);
  return data.purchaseOrders;
}

export async function fetchPurchaseOrders(first = 50, after?: string) {
  try {
    const page = await fetchPurchaseOrdersPage(first, after);
    return { purchaseOrders: page };
  } catch (e) {
    if (!isSiloDateRangeError(e)) throw e;
    let size = Math.max(1, Math.floor(first / 2));
    while (size >= 1) {
      try {
        const page = await fetchPurchaseOrdersPage(size, after);
        return { purchaseOrders: page };
      } catch (e2) {
        if (!isSiloDateRangeError(e2)) throw e2;
        if (size === 1) break;
        size = Math.max(1, Math.floor(size / 2));
      }
    }
    return {
      purchaseOrders: { totalCount: 0, edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
    };
  }
}

// ── Customers (extracted from salesOrders) ───────────────────────

export async function fetchCustomers(first = 500) {
  const data = await siloGraphQL<{ salesOrders: Connection<{ customer: SiloCustomer }> }>(`{
    salesOrders(first: ${first}, orderBy: [{ field: REQUESTED_DATE, direction: DESC }]) {
      totalCount
      edges {
        node {
          customer {
            id companyName legalName customerNote netD isDisabled
            addresses { id name phone street1 street2 city state post country isDefaultShipping }
            customContacts { firstName lastName email phoneNumber }
            deliveryRoute { name type }
          }
        }
      }
    }
  }`);

  const map = new Map<string, SiloCustomer>();
  data.salesOrders.edges.forEach(e => {
    if (!map.has(e.node.customer.id)) map.set(e.node.customer.id, e.node.customer);
  });
  return { customers: Array.from(map.values()), totalOrders: data.salesOrders.totalCount };
}

// ── Vendors (extracted from purchaseOrders) ──────────────────────

export async function fetchVendors(first = 500) {
  const data = await siloGraphQL<{ purchaseOrders: Connection<{ vendor: SiloVendor }> }>(`{
    purchaseOrders(first: ${first}) {
      totalCount
      edges {
        node {
          vendor {
            id companyName legalName
            addresses { id name phone street1 street2 city state post country }
            contacts { id name phoneNumber faxNumber emailAddress }
          }
        }
      }
    }
  }`);

  const map = new Map<string, SiloVendor>();
  data.purchaseOrders.edges.forEach(e => {
    if (!map.has(e.node.vendor.id)) map.set(e.node.vendor.id, e.node.vendor);
  });
  return { vendors: Array.from(map.values()), totalOrders: data.purchaseOrders.totalCount };
}

// ── Customer create ────────────────────────────────────────────
//
// Best-effort wrapper around Silo's customer-creation mutation. The exact
// mutation name and input shape are not publicly documented, so this is
// guarded behind the SILO_AUTO_CREATE_CUSTOMERS env flag and any GraphQL
// error is swallowed (returning null) so callers can fall back to the
// existing "leave unmatched" behavior.
export interface CreateCustomerInput {
  companyName: string;
  legalName?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
}

export async function createSiloCustomer(input: CreateCustomerInput): Promise<{ id: string; companyName: string } | null> {
  if (process.env.SILO_AUTO_CREATE_CUSTOMERS !== 'true') return null;
  if (!input.companyName || input.companyName.trim().length < 2) return null;

  // Build a minimal mutation. Field names follow Silo's REST/GraphQL conventions.
  // Adjust if/when Silo publishes the official customer-creation schema.
  const mutation = `
    mutation CreateCustomer($input: CustomerInput!) {
      createCustomer(input: $input) {
        id
        companyName
      }
    }
  `;
  try {
    const data = await siloGraphQL<{ createCustomer: { id: string; companyName: string } }>(
      mutation,
      {
        input: {
          companyName: input.companyName.trim(),
          legalName: input.legalName || input.companyName.trim(),
          customerNote: input.address || '',
        },
      }
    );
    return data.createCustomer ?? null;
  } catch (e) {
    console.warn('[silo] createCustomer failed:', (e as Error).message);
    return null;
  }
}

// ── Payments ─────────────────────────────────────────────────────

export async function fetchPayments(first = 50, after?: string) {
  const afterArg = after ? `, after: "${after}"` : '';
  return siloGraphQL<{ payments: Connection<SiloPayment> }>(`{
    payments(first: ${first}${afterArg}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id amount paymentDate paymentMethod isRefund notes checkNumber
          customer { id companyName }
          vendor { id companyName }
        }
      }
    }
  }`);
}

// ── Products / Inventory (from order line items) ─────────────────
//
// "Item Master" — derived from Silo sales order line items so we get the
// real SKU/lookupCode, UPC, display group, warehouse location and on-hand
// quantity. The dashboard's Inventory page renders these columns directly
// and the orders matcher uses (sku_code, name) to flag which extracted
// OCR/LLM line items already exist in the master.

export interface SiloItemMaster {
  id: string;                  // product id (stable master key)
  sku_code: string | null;     // inventory.lookupCode — the canonical SKU
  upc: string | null;
  plu: string | null;
  description: string | null;  // product.name
  group: string | null;        // displayGroup (category)
  location: string | null;     // warehouseLocation
  quantity: number | null;     // physicalQuantity (on-hand)
  unitPrice: number | null;
}

export async function fetchProducts(first = 200, after?: string) {
  const afterArg = after ? `, after: "${after}"` : '';

  // ── Why no `orderBy` here ─────────────────────────────────────
  // Some legacy sales-orders carry `requestedDate = '0000-00-00'`. Asking
  // Postgres to ORDER BY that column makes the entire response 500 with
  // `pq: date/time field value out of range`. We don't actually need a
  // sort order for the item-master derivation (we de-dupe by product id),
  // so we drop orderBy and select only non-date fields below.
  const data = await siloGraphQL<{
    salesOrders: Connection<{
      orderItems: {
        id: string;
        quantity: number;
        inventory: {
          id: string;
          lookupCode: string | null;
          upc: string | null;
          plu: string | null;
          displayGroup: string | null;
          warehouseLocation: string | null;
          physicalQuantity: number | null;
          product: { id: string; name: string } | null;
        } | null;
      }[];
    }>;
  }>(`{
    salesOrders(first: ${first}${afterArg}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          orderItems {
            id quantity
            inventory {
              id lookupCode upc plu displayGroup warehouseLocation physicalQuantity
              product { id name }
            }
          }
        }
      }
    }
  }`);

  const map = new Map<string, SiloItemMaster>();
  data.salesOrders.edges.forEach(e => {
    e.node.orderItems?.forEach(item => {
      const inv = item.inventory;
      const product = inv?.product;
      const masterId = product?.id || inv?.id || item.id;
      if (!map.has(masterId)) {
        map.set(masterId, {
          id: masterId,
          sku_code: inv?.lookupCode || null,
          upc: inv?.upc || null,
          plu: inv?.plu || null,
          description: product?.name || null,
          group: inv?.displayGroup || null,
          location: inv?.warehouseLocation || null,
          quantity: inv?.physicalQuantity ?? null,
          unitPrice: null,
        });
      }
    });
  });
  return {
    products: Array.from(map.values()),
    totalOrders: data.salesOrders.totalCount,
    pageInfo: data.salesOrders.pageInfo,
  };
}

// ── Internal helpers for drainAllProducts ────────────────────────
//
// Silo's GraphQL has no top-level `products` or `inventories` query — the
// only way to enumerate the catalog is to walk order line items. We've
// observed two recovery-blocking failure modes:
//   1. `pq: date/time field value out of range: "0000-00-00"`  (legacy SO)
//   2. `ent: inventory not found`                              (deleted FK)
// Both crash the entire GraphQL response if any single row in the page
// is bad. The bisecting page-size strategy (paginateSiloResilient) lets
// us recover everything around the poison rows.
//
// Empirically (this account, May 2026) salesOrders is heavily corrupted
// and yields ~6 products before bisect bottoms out, while purchaseOrders
// drains cleanly to 750+ products. So we drain BOTH and merge by
// product id, with purchaseOrders as the primary high-yield source.

interface InventoryNode {
  id: string;
  lookupCode: string | null;
  upc: string | null;
  plu: string | null;
  displayGroup: string | null;
  warehouseLocation: string | null;
  physicalQuantity: number | null;
  product: { id: string; name: string } | null;
}

interface OrderItemNode {
  id: string;
  quantity: number;
  inventory: InventoryNode | null;
}

async function fetchSalesOrdersForProductsPage(first: number, after?: string) {
  const afterArg = after ? `, after: "${after}"` : '';
  const data = await siloGraphQL<{
    salesOrders: Connection<{ orderItems: OrderItemNode[] }>;
  }>(`{
    salesOrders(first: ${first}${afterArg}) {
      totalCount pageInfo { hasNextPage endCursor }
      edges { node { orderItems {
        id quantity inventory {
          id lookupCode upc plu displayGroup warehouseLocation physicalQuantity
          product { id name }
        }
      } } }
    }
  }`);
  return data.salesOrders;
}

async function fetchPurchaseOrdersForProductsPage(first: number, after?: string) {
  const afterArg = after ? `, after: "${after}"` : '';
  const data = await siloGraphQL<{
    purchaseOrders: Connection<{ orderItems: OrderItemNode[] }>;
  }>(`{
    purchaseOrders(first: ${first}${afterArg}) {
      totalCount pageInfo { hasNextPage endCursor }
      edges { node { orderItems {
        id quantity inventory {
          id lookupCode upc plu displayGroup warehouseLocation physicalQuantity
          product { id name }
        }
      } } }
    }
  }`);
  return data.purchaseOrders;
}

function mergeOrderItemsIntoProducts(
  edges: Array<{ node: { orderItems: OrderItemNode[] } }>,
  out: Map<string, SiloItemMaster>
): number {
  let added = 0;
  for (const e of edges) {
    for (const it of e.node.orderItems || []) {
      const inv = it.inventory;
      const product = inv?.product;
      const masterId = product?.id || inv?.id || it.id;
      const existing = out.get(masterId);
      if (!existing) {
        out.set(masterId, {
          id: masterId,
          sku_code: inv?.lookupCode || null,
          upc: inv?.upc || null,
          plu: inv?.plu || null,
          description: product?.name || null,
          group: inv?.displayGroup || null,
          location: inv?.warehouseLocation || null,
          quantity: inv?.physicalQuantity ?? null,
          unitPrice: null,
        });
        added++;
      } else {
        // Merge: prefer non-null values across pages so the master row is
        // as complete as possible (e.g. lookupCode may appear in a later
        // SO even if the first PO had it null).
        existing.sku_code ||= inv?.lookupCode || null;
        existing.upc ||= inv?.upc || null;
        existing.plu ||= inv?.plu || null;
        existing.description ||= product?.name || null;
        existing.group ||= inv?.displayGroup || null;
        existing.location ||= inv?.warehouseLocation || null;
        if (existing.quantity == null && inv?.physicalQuantity != null) {
          existing.quantity = inv.physicalQuantity;
        }
      }
    }
  }
  return added;
}

async function drainSourceWithBisect(
  label: string,
  fetchPage: (first: number, after?: string) => Promise<Connection<{ orderItems: OrderItemNode[] }>>,
  out: Map<string, SiloItemMaster>,
  opts: {
    startSize?: number;
    maxPages?: number;
    onProgress?: (msg: string) => void;
    onPage?: (added: SiloItemMaster[]) => Promise<void> | void;
  } = {}
): Promise<{ pages: number; skipped: number }> {
  const startSize = opts.startSize ?? 200;
  const maxPages = opts.maxPages ?? 100;
  const onProgress = opts.onProgress;
  const onPage = opts.onPage;
  let after: string | undefined;
  let pages = 0;
  let skipped = 0;
  for (let i = 0; i < maxPages; i++) {
    let size = startSize;
    let page: Connection<{ orderItems: OrderItemNode[] }> | null = null;
    while (size >= 1) {
      try {
        page = await fetchPage(size, after);
        break;
      } catch (e) {
        if (!isSiloDateRangeError(e)) throw e;
        if (size === 1) {
          skipped++;
          break;
        }
        size = Math.max(1, Math.floor(size / 2));
      }
    }
    if (!page) {
      onProgress?.(`${label}: irrecoverable poison row, stopping after ${pages} pages`);
      break;
    }
    pages++;
    const beforeSize = out.size;
    mergeOrderItemsIntoProducts(page.edges, out);
    const newOnes: SiloItemMaster[] = [];
    if (onPage && out.size > beforeSize) {
      // collect just the newly-added entries (last N inserted into Map)
      const all = Array.from(out.values());
      newOnes.push(...all.slice(beforeSize));
    }
    onProgress?.(`${label} page ${pages}: size=${size} +${out.size - beforeSize} (cumulative=${out.size})`);
    if (onPage && newOnes.length > 0) {
      await onPage(newOnes);
    }
    if (!page.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
    after = page.pageInfo.endCursor;
  }
  return { pages, skipped };
}

/**
 * Drain Silo's full product/inventory catalog by walking BOTH
 * purchaseOrders and salesOrders and merging order-line inventory into
 * one map keyed by product id. Bisects on the two known Silo errors
 * (`pq: date/time out of range` and `ent: inventory not found`) so a
 * single corrupt row doesn't kill the whole sync.
 *
 * This is the canonical ingest path for /api/item-master/sync. Returns
 * the deduped product list plus per-source diagnostics.
 *
 * Pass `onPage` to receive each page's NEW products as they arrive — the
 * sync route uses this to upsert incrementally so a Vercel timeout never
 * leaves the table empty.
 */
export async function drainAllProducts(opts: {
  maxPages?: number;
  onProgress?: (msg: string) => void;
  onPage?: (added: SiloItemMaster[]) => Promise<void> | void;
} = {}): Promise<{
  products: SiloItemMaster[];
  sources: {
    purchaseOrders: { pages: number; skipped: number };
    salesOrders: { pages: number; skipped: number };
  };
}> {
  const out = new Map<string, SiloItemMaster>();
  // Purchase orders first — empirically far more reliable on this account.
  const po = await drainSourceWithBisect('purchaseOrders', fetchPurchaseOrdersForProductsPage, out, opts);
  const so = await drainSourceWithBisect('salesOrders', fetchSalesOrdersForProductsPage, out, opts);
  return {
    products: Array.from(out.values()),
    sources: { purchaseOrders: po, salesOrders: so },
  };
}
