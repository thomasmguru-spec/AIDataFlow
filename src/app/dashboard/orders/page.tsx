'use client';

import { Card, Badge } from '@/components/ui';
import { formatCurrency, formatDate, getStatusColor } from '@/lib/utils';
import { Package, RefreshCw, ChevronLeft, ChevronRight, ExternalLink, MessageSquare, Mail, ScanLine, Cloud, Image, FileText, Phone } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';

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

interface SiloSalesOrder {
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

interface SiloPurchaseOrder {
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

interface NewOrderLine {
  line_number: number | null;
  sku_name: string | null;
  sku_code: string | null;
  description: string | null;
  quantity: number | null;
  unit_of_measure: string | null;
  unit_price: number | null;
  line_total: number | null;
  sku_matched?: boolean;
  item_master?: {
    matched: boolean;
    match_method: 'sku' | 'upc' | 'name_exact' | 'name_fuzzy' | null;
    master_sku_code: string | null;
    master_description: string | null;
    master_group: string | null;
    master_location: string | null;
    master_on_hand: number | null;
    master_unit_price: number | null;
  } | null;
}

interface NewOrder {
  id: string;
  order_number: string | null;
  order_date: string | null;
  delivery_date: string | null;
  customer_name: string | null;
  customer_code?: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  customer_whatsapp: string | null;
  billing_address: string | null;
  shipping_address: string | null;
  payment_terms?: string | null;
  special_instructions?: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  validation_status: string | null;
  exception_status: string | null;
  export_status: string | null;
  approval_status: string | null;
  created_at: string;
  document_id?: string | null;
  documents: {
    source: string;
    original_filename: string;
    received_at: string;
    source_identifier?: string | null;
    file_mime_type?: string | null;
  };
  order_lines: NewOrderLine[] | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

const SOURCE_ICONS: Record<string, typeof MessageSquare> = {
  whatsapp: MessageSquare,
  email: Mail,
  scanner: ScanLine,
  google_drive: Cloud,
  cloud_upload: Cloud,
};

const SOURCE_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  email: 'Email',
  scanner: 'Scanner',
  google_drive: 'Google Drive',
  cloud_upload: 'Upload',
};

const SILO_URL = 'https://app.usesilo.com';
const PAGE_SIZE = 50;

export default function OrdersPage() {
  const [mainTab, setMainTab] = useState<'whatsapp' | 'new' | 'silo'>('whatsapp');
  const [tab, setTab] = useState<'sales' | 'purchase'>('sales');
  const [salesOrders, setSalesOrders] = useState<SiloSalesOrder[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<SiloPurchaseOrder[]>([]);
  const [salesTotal, setSalesTotal] = useState(0);
  const [purchaseTotal, setPurchaseTotal] = useState(0);
  const [salesPageInfo, setSalesPageInfo] = useState<PageInfo>({ hasNextPage: false, endCursor: null });
  const [purchasePageInfo, setPurchasePageInfo] = useState<PageInfo>({ hasNextPage: false, endCursor: null });
  const [newOrders, setNewOrders] = useState<NewOrder[]>([]);
  const [newOrdersTotal, setNewOrdersTotal] = useState(0);
  const [newOrdersSource, setNewOrdersSource] = useState('');
  const [gdriveSyncing, setGdriveSyncing] = useState(false);
  const [bulkReprocessing, setBulkReprocessing] = useState(false);
  const [whatsappMessages, setWhatsappMessages] = useState<WhatsAppMessage[]>([]);
  const [whatsappTotal, setWhatsappTotal] = useState(0);
  const [whatsappLoading, setWhatsappLoading] = useState(false);
  const [expandedMsg, setExpandedMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<'admin' | 'manager' | 'validator' | 'user'>('user');
  const [newOrdersPage, setNewOrdersPage] = useState(1);
  const [whatsappPage, setWhatsappPage] = useState(1);

  const canReview = ['admin', 'manager', 'validator'].includes(myRole);
  const canApprove = ['admin', 'manager'].includes(myRole);

  const TABLE_PAGE_SIZE = 10;
  const paginatedNewOrders = newOrders.slice((newOrdersPage - 1) * TABLE_PAGE_SIZE, newOrdersPage * TABLE_PAGE_SIZE);
  const totalNewOrdersPages = Math.max(1, Math.ceil(newOrders.length / TABLE_PAGE_SIZE));
  const paginatedWhatsapp = whatsappMessages.slice((whatsappPage - 1) * TABLE_PAGE_SIZE, whatsappPage * TABLE_PAGE_SIZE);
  const totalWhatsappPages = Math.max(1, Math.ceil(whatsappMessages.length / TABLE_PAGE_SIZE));

  const blankGoogleDriveCount = newOrders.filter((o) =>
    o.documents?.source === 'google_drive' &&
    ((o.order_lines?.length ?? 0) === 0 || (!o.order_number && !o.customer_name && o.total_amount == null))
  ).length;

  useEffect(() => {
    fetch('/api/me')
      .then((r) => r.json())
      .then((j) => { if (j.user?.role) setMyRole(j.user.role); })
      .catch(() => { /* ignore */ });
  }, []);

  const fetchSiloOrders = useCallback(async (type: 'sales' | 'purchase', after?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ type, limit: '500' });
      if (after) params.set('after', after);
      const res = await fetch(`/api/silo/orders?${params}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (type === 'sales') {
        const newOrders = data.edges.map((e: { node: SiloSalesOrder }) => e.node);
        setSalesOrders(prev => {
          const all = after ? [...prev, ...newOrders] : newOrders;
          return all.sort((a: SiloSalesOrder, b: SiloSalesOrder) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        });
        setSalesTotal(data.totalCount);
        setSalesPageInfo(data.pageInfo);
      } else {
        const newOrders = data.edges.map((e: { node: SiloPurchaseOrder }) => e.node);
        setPurchaseOrders(prev => {
          const all = after ? [...prev, ...newOrders] : newOrders;
          return all.sort((a: SiloPurchaseOrder, b: SiloPurchaseOrder) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        });
        setPurchaseTotal(data.totalCount);
        setPurchasePageInfo(data.pageInfo);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch orders');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchNewOrders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (newOrdersSource) params.set('source', newOrdersSource);
      const res = await fetch(`/api/orders/new?${params}`);
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const json = await res.json();
      setNewOrders(json.data || []);
      setNewOrdersTotal(json.total || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch new orders');
    } finally {
      setLoading(false);
    }
  }, [newOrdersSource]);

  /**
   * On-demand: import any new files from the customer-orders Google Drive
   * folder, then run OCR + LLM extraction for every pending document
   * (newly imported AND any older imports that never finished processing).
   *
   * Why this is structured as multiple short HTTP calls instead of one big
   * server-side job:
   *   - Vercel serverless functions have a 60s wall-clock budget. Doing
   *     N file-downloads + N OCR+LLM calls in one route trips the budget
   *     and Vercel returns an HTML 504 page (which previously broke
   *     `res.json()` with "Unexpected token 'A'..." in the dashboard).
   *   - Splitting the work lets each /api/process invocation get its own
   *     60s budget. The browser orchestrates concurrency.
   */
  const syncGoogleDriveOrders = useCallback(async () => {
    setGdriveSyncing(true);
    try {
      // ── STEP 1: Import a small batch of any NEW files in the Drive folder.
      const importRes = await fetch('/api/gdrive/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_kind: 'orders', batch_size: 5 }),
      });
      const importRaw = await importRes.text();
      let importJson: { imported?: number; total_in_folder?: number; remaining_unimported?: number; new_documents?: { document_id: string }[]; error?: string } = {};
      try { importJson = importRaw ? JSON.parse(importRaw) : {}; }
      catch {
        const snippet = importRaw.slice(0, 120).replace(/\s+/g, ' ').trim();
        throw new Error(importRes.ok
          ? `Server returned non-JSON response: "${snippet}"`
          : `HTTP ${importRes.status}: ${snippet || importRes.statusText}`);
      }
      if (!importRes.ok) throw new Error(importJson.error || `HTTP ${importRes.status}`);

      const importedCount = importJson.imported ?? 0;
      const remaining = importJson.remaining_unimported ?? 0;

      // ── STEP 2: Fetch ALL docs in the orders folder that still need
      // OCR/LLM processing (status='new' / 'failed' / 'exception' / etc).
      const pendingRes = await fetch('/api/gdrive/process-pending?folder_kind=orders&limit=500');
      const pendingJson = await pendingRes.json().catch(() => ({}));
      const pendingIds: string[] = pendingJson?.document_ids || [];

      if (importedCount > 0) {
        toast.success(
          `Imported ${importedCount} new document(s)` +
          (remaining > 0 ? ` (${remaining} more queued — click Sync again).` : '.')
        );
      } else if (pendingIds.length === 0) {
        toast(`No new files (${importJson.total_in_folder ?? 0} already imported).`);
      }

      // ── STEP 3: Process pending docs concurrently with limited parallelism.
      // Too much parallelism saturates the OpenRouter free model and Vision
      // API. Three at a time is a good compromise.
      if (pendingIds.length > 0) {
        toast(`Running OCR + LLM extraction on ${pendingIds.length} document(s)…`);
        const PARALLEL = 3;
        let ok = 0;
        let failed = 0;
        const queue = pendingIds.slice();
        const worker = async () => {
          while (queue.length > 0) {
            const id = queue.shift();
            if (!id) return;
            try {
              const r = await fetch('/api/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ document_id: id }),
              });
              if (!r.ok) {
                failed++;
                // eslint-disable-next-line no-console
                console.error(`[gdrive sync] process(${id}) HTTP ${r.status}`);
              } else {
                ok++;
              }
            } catch (e) {
              failed++;
              // eslint-disable-next-line no-console
              console.error(`[gdrive sync] process(${id}) threw`, e);
            }
            // Refresh table periodically so the user sees progress.
            if ((ok + failed) % 3 === 0) await fetchNewOrders();
          }
        };
        await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
        if (failed > 0) {
          toast.error(`OCR/LLM failed for ${failed}/${pendingIds.length} document(s) — see console.`);
        } else {
          toast.success(`Processed ${ok} document(s) successfully.`);
        }
      }

      await fetchNewOrders();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setGdriveSyncing(false);
    }
  }, [fetchNewOrders]);

  /**
   * Re-run the OCR + LLM pipeline on a single document. Used from the
   * Reprocess button on order rows whose extraction failed (status='failed'
   * or empty line items).
   */
  const reprocessDocument = useCallback(async (documentId: string) => {
    try {
      const r = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: documentId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(j.error || `Reprocess failed: HTTP ${r.status}`);
        return;
      }
      toast.success('Reprocess complete.');
      await fetchNewOrders();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reprocess failed');
    }
  }, [fetchNewOrders]);

  const reprocessBlankGoogleDrive = useCallback(async () => {
    const targets = newOrders
      .filter((o) =>
        o.documents?.source === 'google_drive' &&
        ((o.order_lines?.length ?? 0) === 0 || (!o.order_number && !o.customer_name && o.total_amount == null))
      )
      .map((o) => o.document_id ?? o.id)
      .filter((id): id is string => !!id)
      .slice(0, 10);

    if (targets.length === 0) {
      toast('No blank Google Drive rows to reprocess.');
      return;
    }

    setBulkReprocessing(true);
    try {
      let ok = 0;
      let failed = 0;
      const queue = targets.slice();
      const PARALLEL = 2;

      const worker = async () => {
        while (queue.length > 0) {
          const id = queue.shift();
          if (!id) return;
          try {
            const r = await fetch('/api/process', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ document_id: id }),
            });
            if (r.ok) ok++;
            else failed++;
          } catch {
            failed++;
          }
        }
      };

      toast(`Reprocessing ${targets.length} blank Google Drive row(s)…`);
      await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
      await fetchNewOrders();
      if (failed > 0) toast.error(`Reprocessed ${ok}/${targets.length}. ${failed} failed.`);
      else toast.success(`Reprocessed ${ok} row(s) successfully.`);
    } finally {
      setBulkReprocessing(false);
    }
  }, [newOrders, fetchNewOrders]);

  async function approveOrderAction(id: string, action: 'review' | 'approve' | 'reject') {
    let reason: string | null = null;
    if (action === 'reject') {
      reason = window.prompt('Rejection reason?') || null;
      if (reason === null) return;
    }
    const r = await fetch(`/api/orders/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason }),
    });
    const j = await r.json();
    if (!r.ok) { toast.error(j.error || 'Action failed'); return; }
    toast.success(`Order ${action === 'review' ? 'sent for review' : action + 'd'}`);
    fetchNewOrders();
  }

  const fetchWhatsAppMessages = useCallback(async () => {
    setWhatsappLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/whatsapp/messages?limit=200');
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const json = await res.json();
      setWhatsappMessages(json.data || []);
      setWhatsappTotal(json.total || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch WhatsApp messages');
    } finally {
      setWhatsappLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSiloOrders('sales');
    fetchSiloOrders('purchase');
  }, [fetchSiloOrders]);

  useEffect(() => {
    if (mainTab === 'new') fetchNewOrders();
    if (mainTab === 'whatsapp') fetchWhatsAppMessages();
  }, [mainTab, fetchNewOrders, fetchWhatsAppMessages]);

  useEffect(() => { setNewOrdersPage(1); }, [newOrdersSource]);

  const currentOrders = tab === 'sales' ? salesOrders : purchaseOrders;
  const currentTotal = tab === 'sales' ? salesTotal : purchaseTotal;
  const currentPageInfo = tab === 'sales' ? salesPageInfo : purchasePageInfo;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Orders</h1>
          <p className="text-slate-500 mt-1">
            {mainTab === 'whatsapp'
              ? `${whatsappTotal} WhatsApp messages — items extracted from text & images`
              : mainTab === 'silo'
              ? `Live data from Silo WMS — ${salesTotal.toLocaleString()} sales, ${purchaseTotal.toLocaleString()} purchase orders`
              : `${newOrdersTotal.toLocaleString()} new orders from WhatsApp, Email, Scanner & Cloud`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => mainTab === 'whatsapp' ? fetchWhatsAppMessages() : mainTab === 'silo' ? fetchSiloOrders(tab) : fetchNewOrders()}
            disabled={loading || whatsappLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading || whatsappLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <a href={SILO_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg transition">
            Open Silo <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      {/* Main Tabs: WhatsApp Messages vs New vs Silo */}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-lg w-fit">
        <button
          onClick={() => setMainTab('whatsapp')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition flex items-center gap-1.5 ${
            mainTab === 'whatsapp' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <MessageSquare className="w-4 h-4" /> WhatsApp Messages ({whatsappTotal})
        </button>
        <button
          onClick={() => setMainTab('new')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition ${
            mainTab === 'new' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          New Orders ({newOrdersTotal})
        </button>
        <button
          onClick={() => setMainTab('silo')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition ${
            mainTab === 'silo' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Silo Orders
        </button>
      </div>

      {error && <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {/* ─── WHATSAPP MESSAGES VIEW ─── */}
      {mainTab === 'whatsapp' && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  <th className="px-6 py-3 font-medium">Sender</th>
                  <th className="px-6 py-3 font-medium">Message</th>
                  <th className="px-6 py-3 font-medium">Type</th>
                  <th className="px-6 py-3 font-medium">Name and Location</th>
                  <th className="px-6 py-3 font-medium">Item Name</th>
                  <th className="px-6 py-3 font-medium">Quantity</th>
                  <th className="px-6 py-3 font-medium">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {whatsappLoading && whatsappMessages.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                      <RefreshCw className="w-6 h-6 text-slate-300 mx-auto mb-2 animate-spin" />
                      Loading WhatsApp messages from Twilio...
                    </td>
                  </tr>
                ) : whatsappMessages.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                      <MessageSquare className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                      No WhatsApp messages found
                    </td>
                  </tr>
                ) : (
                  paginatedWhatsapp.map((msg) => {
                    const hasItems = msg.items.length > 0;
                    const isExpanded = expandedMsg === msg.sid;

                    // If message has items, show each item as a row
                    if (hasItems) {
                      return msg.items.map((item, idx) => (
                        <tr key={`${msg.sid}-${idx}`} className="hover:bg-slate-50">
                          {idx === 0 ? (
                            <>
                              <td className="px-6 py-3 text-slate-700" rowSpan={msg.items.length}>
                                <div className="flex items-center gap-1.5">
                                  <Phone className="w-3.5 h-3.5 text-green-600" />
                                  <span className="font-medium">{msg.from}</span>
                                </div>
                              </td>
                              <td className="px-6 py-3 text-slate-600 max-w-[250px]" rowSpan={msg.items.length}>
                                <div className="truncate" title={msg.body || msg.ocrText || ''}>
                                  {msg.body || (msg.ocrText ? msg.ocrText.substring(0, 100) + '...' : '—')}
                                </div>
                                {msg.ocrText && (
                                  <button
                                    onClick={() => setExpandedMsg(isExpanded ? null : msg.sid)}
                                    className="text-xs text-brand-600 hover:text-brand-700 mt-1"
                                  >
                                    {isExpanded ? 'Hide OCR text' : 'Show OCR text'}
                                  </button>
                                )}
                                {isExpanded && msg.ocrText && (
                                  <div className="mt-2 p-2 bg-slate-50 rounded text-xs text-slate-600 whitespace-pre-wrap max-h-40 overflow-y-auto">
                                    {msg.ocrText}
                                  </div>
                                )}
                              </td>
                              <td className="px-6 py-3" rowSpan={msg.items.length}>
                                {msg.numMedia > 0 ? (
                                  <Badge className="bg-purple-100 text-purple-800">
                                    <Image className="w-3 h-3 mr-1" /> Image
                                  </Badge>
                                ) : (
                                  <Badge className="bg-blue-100 text-blue-800">
                                    <FileText className="w-3 h-3 mr-1" /> Text
                                  </Badge>
                                )}
                              </td>
                              <td className="px-6 py-3 text-slate-700" rowSpan={msg.items.length}>
                                {msg.nameAndLocation || '—'}
                              </td>
                            </>
                          ) : null}
                          <td className="px-6 py-3 font-medium text-slate-900">{item.itemName}</td>
                          <td className="px-6 py-3 text-slate-700 font-semibold">{item.quantity}</td>
                          {idx === 0 ? (
                            <td className="px-6 py-3 text-slate-500 text-xs" rowSpan={msg.items.length}>
                              {formatDate(msg.dateSent)}
                            </td>
                          ) : null}
                        </tr>
                      ));
                    }

                    // Message without extracted items
                    return (
                      <tr key={msg.sid} className="hover:bg-slate-50">
                        <td className="px-6 py-3 text-slate-700">
                          <div className="flex items-center gap-1.5">
                            <Phone className="w-3.5 h-3.5 text-green-600" />
                            <span className="font-medium">{msg.from}</span>
                          </div>
                        </td>
                        <td className="px-6 py-3 text-slate-600 max-w-[250px]">
                          <div className="truncate" title={msg.body || msg.ocrText || ''}>
                            {msg.body || (msg.ocrText ? msg.ocrText.substring(0, 100) + '...' : '—')}
                          </div>
                          {msg.ocrText && (
                            <>
                              <button
                                onClick={() => setExpandedMsg(isExpanded ? null : msg.sid)}
                                className="text-xs text-brand-600 hover:text-brand-700 mt-1"
                              >
                                {isExpanded ? 'Hide OCR text' : 'Show OCR text'}
                              </button>
                              {isExpanded && (
                                <div className="mt-2 p-2 bg-slate-50 rounded text-xs text-slate-600 whitespace-pre-wrap max-h-40 overflow-y-auto">
                                  {msg.ocrText}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td className="px-6 py-3">
                          {msg.numMedia > 0 ? (
                            <Badge className="bg-purple-100 text-purple-800">
                              <Image className="w-3 h-3 mr-1" /> Image
                            </Badge>
                          ) : (
                            <Badge className="bg-blue-100 text-blue-800">
                              <FileText className="w-3 h-3 mr-1" /> Text
                            </Badge>
                          )}
                        </td>
                        <td className="px-6 py-3 text-slate-700">{msg.nameAndLocation || '—'}</td>
                        <td className="px-6 py-3 text-slate-400 italic">No items extracted</td>
                        <td className="px-6 py-3 text-slate-400">—</td>
                        <td className="px-6 py-3 text-slate-500 text-xs">{formatDate(msg.dateSent)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {whatsappMessages.length > 0 && (
            <div className="flex items-center justify-between px-6 py-3 border-t border-slate-100">
              <span className="text-sm text-slate-500">
                Showing {(whatsappPage - 1) * TABLE_PAGE_SIZE + 1}–{Math.min(whatsappPage * TABLE_PAGE_SIZE, whatsappMessages.length)} of {whatsappMessages.length} messages
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setWhatsappPage(p => Math.max(1, p - 1))}
                  disabled={whatsappPage === 1}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" /> Prev
                </button>
                <span className="text-sm text-slate-500">{whatsappPage} / {totalWhatsappPages}</span>
                <button
                  onClick={() => setWhatsappPage(p => Math.min(totalWhatsappPages, p + 1))}
                  disabled={whatsappPage === totalWhatsappPages}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ─── SILO ORDERS VIEW ─── */}
      {mainTab === 'silo' && (
        <>
          {/* Sub-tabs: Sales vs Purchase */}
          <div className="flex gap-1 bg-slate-50 p-1 rounded-lg w-fit">
            <button
              onClick={() => setTab('sales')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition ${
                tab === 'sales' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Sales Orders ({salesTotal.toLocaleString()})
            </button>
            <button
              onClick={() => setTab('purchase')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition ${
                tab === 'purchase' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Purchase Orders ({purchaseTotal.toLocaleString()})
            </button>
          </div>

          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-100">
                    {tab === 'sales' ? (
                      <>
                        <th className="px-6 py-3 font-medium">Invoice #</th>
                        <th className="px-6 py-3 font-medium">Customer PO #</th>
                        <th className="px-6 py-3 font-medium">Customer</th>
                        <th className="px-6 py-3 font-medium">Order Date</th>
                        <th className="px-6 py-3 font-medium">Delivery Date</th>
                        <th className="px-6 py-3 font-medium">Total</th>
                        <th className="px-6 py-3 font-medium">Balance</th>
                        <th className="px-6 py-3 font-medium">Payment</th>
                        <th className="px-6 py-3 font-medium">Method</th>
                      </>
                    ) : (
                      <>
                        <th className="px-6 py-3 font-medium">PO #</th>
                        <th className="px-6 py-3 font-medium">Vendor Invoice #</th>
                        <th className="px-6 py-3 font-medium">Vendor</th>
                        <th className="px-6 py-3 font-medium">Order Date</th>
                        <th className="px-6 py-3 font-medium">Delivery Date</th>
                        <th className="px-6 py-3 font-medium">Received</th>
                        <th className="px-6 py-3 font-medium">Total</th>
                        <th className="px-6 py-3 font-medium">Method</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading && currentOrders.length === 0 ? (
                    <tr><td colSpan={9} className="px-6 py-12 text-center text-slate-500">
                      <RefreshCw className="w-6 h-6 text-slate-300 mx-auto mb-2 animate-spin" /> Loading orders from Silo...
                    </td></tr>
                  ) : currentOrders.length === 0 ? (
                    <tr><td colSpan={9} className="px-6 py-12 text-center text-slate-500">
                      <Package className="w-8 h-8 text-slate-300 mx-auto mb-2" /> No orders found
                    </td></tr>
                  ) : tab === 'sales' ? (
                    salesOrders.map((o) => (
                      <tr key={o.id} className="hover:bg-slate-50">
                        <td className="px-6 py-3 font-medium text-slate-900">{o.invoiceNumber || '—'}</td>
                        <td className="px-6 py-3 text-slate-600">{o.customerPurchaseOrderNumber || '—'}</td>
                        <td className="px-6 py-3 text-slate-700 max-w-[200px] truncate">{o.customer.companyName}</td>
                        <td className="px-6 py-3 text-slate-600">{formatDate(o.createdAt)}</td>
                        <td className="px-6 py-3 text-slate-500">{formatDate(o.requestedDate)}</td>
                        <td className="px-6 py-3 font-medium">{formatCurrency(o.orderTotal)}</td>
                        <td className="px-6 py-3 text-slate-600">{formatCurrency(o.remainingBalance)}</td>
                        <td className="px-6 py-3">
                          <Badge className={
                            o.paymentStatus === 'PAID' ? 'bg-green-100 text-green-800' :
                            o.paymentStatus === 'UNPAID' ? 'bg-red-100 text-red-800' :
                            o.paymentStatus === 'PARTIALLY_PAID' ? 'bg-amber-100 text-amber-800' :
                            'bg-slate-100 text-slate-600'
                          }>{o.paymentStatus}</Badge>
                        </td>
                        <td className="px-6 py-3 text-slate-500 text-xs">{o.transportMethod}</td>
                      </tr>
                    ))
                  ) : (
                    purchaseOrders.map((o) => (
                      <tr key={o.id} className="hover:bg-slate-50">
                        <td className="px-6 py-3 font-medium text-slate-900">{o.purchaseOrderNumber}</td>
                        <td className="px-6 py-3 text-slate-600">{o.customerInvoiceNumber || '—'}</td>
                        <td className="px-6 py-3 text-slate-700 max-w-[200px] truncate">{o.vendor.companyName}</td>
                        <td className="px-6 py-3 text-slate-600">{formatDate(o.createdAt)}</td>
                        <td className="px-6 py-3 text-slate-500">{formatDate(o.requestedDate)}</td>
                        <td className="px-6 py-3 text-slate-600">{formatDate(o.receivedDate)}</td>
                        <td className="px-6 py-3 font-medium">{formatCurrency(o.orderTotal)}</td>
                        <td className="px-6 py-3 text-slate-500 text-xs">{o.transportMethod}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {currentOrders.length > 0 && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-slate-100">
                <p className="text-sm text-slate-500">Showing {currentOrders.length} of {currentTotal.toLocaleString()} orders</p>
                {currentPageInfo.hasNextPage && (
                  <button
                    onClick={() => fetchSiloOrders(tab, currentPageInfo.endCursor || undefined)}
                    disabled={loading}
                    className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
                  >
                    Load more <ChevronRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      {/* ─── NEW ORDERS VIEW ─── */}
      {mainTab === 'new' && (
        <>
          {/* Source filter */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex gap-1 bg-slate-50 p-1 rounded-lg w-fit">
              {[
                { value: '', label: 'All Sources' },
                { value: 'whatsapp', label: 'WhatsApp' },
                { value: 'email', label: 'Email' },
                { value: 'scanner', label: 'Scanner' },
                { value: 'google_drive', label: 'Google Drive' },
              ].map(s => (
                <button
                  key={s.value}
                  onClick={() => setNewOrdersSource(s.value)}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition ${
                    newOrdersSource === s.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {newOrdersSource === 'google_drive' && (
              <div className="flex items-center gap-2">
                <button
                  onClick={syncGoogleDriveOrders}
                  disabled={gdriveSyncing}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Import any new order PDFs/images from the Google Drive orders folder and run OCR + LLM extraction"
                >
                  <RefreshCw className={`w-4 h-4 ${gdriveSyncing ? 'animate-spin' : ''}`} />
                  {gdriveSyncing ? 'Syncing…' : 'Sync Google Drive Orders'}
                </button>
                <button
                  onClick={reprocessBlankGoogleDrive}
                  disabled={bulkReprocessing || blankGoogleDriveCount === 0}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Re-run OCR + LLM extraction for blank Google Drive rows (up to 10 at a time)"
                >
                  <RefreshCw className={`w-4 h-4 ${bulkReprocessing ? 'animate-spin' : ''}`} />
                  {bulkReprocessing ? 'Reprocessing…' : `Reprocess Blank (${blankGoogleDriveCount})`}
                </button>
              </div>
            )}
          </div>

          <Card>
            <div className="overflow-x-auto">
              {/* Dense data table — the OCR + LLM + Item-Master pipeline can
                  produce very long values (multi-line addresses, many items).
                  We render every value in full at 8px so the client never
                  loses information to truncation. */}
              <table className="w-full" style={{ fontSize: '12px', lineHeight: 1.35 }}>
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-200 bg-slate-50/60 uppercase tracking-wide" style={{ fontSize: '12px' }}>
                    <th className="px-2 py-2 font-semibold align-bottom">Source</th>
                    <th className="px-2 py-2 font-semibold align-bottom">Order #</th>
                    <th className="px-2 py-2 font-semibold align-bottom">Client / Contact</th>
                    <th className="px-2 py-2 font-semibold align-bottom">Billing / Shipping</th>
                    <th className="px-2 py-2 font-semibold align-bottom">Extracted Line Items (OCR + AI/LLM &rarr; Item Master)</th>
                    <th className="px-2 py-2 font-semibold align-bottom whitespace-nowrap">Order Date</th>
                    <th className="px-2 py-2 font-semibold align-bottom whitespace-nowrap">Delivery</th>
                    <th className="px-2 py-2 font-semibold align-bottom text-right">Subtotal</th>
                    <th className="px-2 py-2 font-semibold align-bottom text-right">Tax</th>
                    <th className="px-2 py-2 font-semibold align-bottom text-right">Total</th>
                    <th className="px-2 py-2 font-semibold align-bottom">Status</th>
                    <th className="px-2 py-2 font-semibold align-bottom">Approval</th>
                    <th className="px-2 py-2 font-semibold align-bottom">Export</th>
                    <th className="px-2 py-2 font-semibold align-bottom whitespace-nowrap">Received</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100" style={{ fontSize: '12px' }}>
                  {loading && newOrders.length === 0 ? (
                    <tr><td colSpan={14} className="px-2 py-12 text-center text-slate-500" style={{ fontSize: '11px' }}>
                      <RefreshCw className="w-6 h-6 text-slate-300 mx-auto mb-2 animate-spin" /> Loading new orders...
                    </td></tr>
                  ) : newOrders.length === 0 ? (
                    <tr><td colSpan={14} className="px-2 py-12 text-center text-slate-500" style={{ fontSize: '11px' }}>
                      <Package className="w-8 h-8 text-slate-300 mx-auto mb-2" /> No new orders found
                    </td></tr>
                  ) : paginatedNewOrders.map(o => {
                    const src = o.documents?.source || 'unknown';
                    const Icon = SOURCE_ICONS[src] || Package;
                    const driveFileId = src === 'google_drive' ? o.documents?.source_identifier : null;
                    const driveMime = o.documents?.file_mime_type || '';
                    const driveUrl = driveFileId ? `https://drive.google.com/file/d/${driveFileId}/view` : null;
                    const driveThumb = driveFileId
                      ? `https://drive.google.com/thumbnail?id=${driveFileId}&sz=w64`
                      : null;
                    const driveFilename = o.documents?.original_filename || 'Open in Google Drive';
                    const ap = o.approval_status || 'draft';
                    // Sort line items by line_number for stable display.
                    const lines = (o.order_lines || [])
                      .slice()
                      .sort((a, b) => (a.line_number ?? 0) - (b.line_number ?? 0));
                    return (
                      <tr key={o.id} className="hover:bg-slate-50 align-top">
                        {/* SOURCE */}
                        <td className="px-2 py-2 align-top">
                          {driveUrl ? (
                            <a
                              href={driveUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Open "${driveFilename}" in Google Drive`}
                              className="inline-flex items-start gap-1 group"
                            >
                              {driveThumb ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={driveThumb}
                                  alt={driveFilename}
                                  width={28}
                                  height={28}
                                  loading="lazy"
                                  referrerPolicy="no-referrer"
                                  className="w-7 h-7 rounded border border-slate-200 object-cover bg-slate-50 shrink-0"
                                  onError={(e) => {
                                    const target = e.currentTarget;
                                    target.style.display = 'none';
                                    const fb = target.nextElementSibling as HTMLElement | null;
                                    if (fb) fb.style.display = 'inline-flex';
                                  }}
                                />
                              ) : null}
                              <span
                                className="w-7 h-7 rounded border border-slate-200 bg-slate-50 items-center justify-center text-slate-500 shrink-0"
                                style={{ display: driveThumb ? 'none' : 'inline-flex' }}
                              >
                                {driveMime.startsWith('image/') ? (
                                  <Image className="w-3 h-3" />
                                ) : (
                                  <FileText className="w-3 h-3" />
                                )}
                              </span>
                              <span className="text-slate-700 group-hover:text-brand-600 group-hover:underline break-all">
                                {SOURCE_LABELS[src] || src}<br/>
                                <span className="text-slate-500 break-all">{driveFilename}</span>
                              </span>
                            </a>
                          ) : (
                            <div className="flex items-center gap-1">
                              <Icon className="w-3 h-3 text-slate-400" />
                              <span className="text-slate-600">{SOURCE_LABELS[src] || src}</span>
                            </div>
                          )}
                        </td>

                        {/* ORDER # */}
                        <td className="px-2 py-2 font-semibold text-slate-900 break-all align-top">{o.order_number || '—'}</td>

                        {/* CLIENT / CONTACT — full address shown, not truncated */}
                        <td className="px-2 py-2 text-slate-700 align-top whitespace-normal break-words" style={{ minWidth: 110, maxWidth: 180 }}>
                          <div className="font-semibold text-slate-900">{o.customer_name || '—'}</div>
                          {o.customer_code && <div className="text-slate-600">Code: {o.customer_code}</div>}
                          {o.customer_phone && <div className="text-slate-600">📞 {o.customer_phone}</div>}
                          {o.customer_whatsapp && <div className="text-slate-600">🟢 {o.customer_whatsapp}</div>}
                          {o.customer_email && <div className="text-slate-600 break-all">✉ {o.customer_email}</div>}
                        </td>

                        {/* BILLING / SHIPPING — fully expanded */}
                        <td className="px-2 py-2 text-slate-700 align-top whitespace-pre-wrap break-words" style={{ minWidth: 130, maxWidth: 220 }}>
                          {o.billing_address && (
                            <div className="mb-1">
                              <span className="font-semibold text-slate-500">BILL:</span> <span className="text-slate-700">{o.billing_address}</span>
                            </div>
                          )}
                          {o.shipping_address && (
                            <div>
                              <span className="font-semibold text-slate-500">SHIP:</span> <span className="text-slate-700">{o.shipping_address}</span>
                            </div>
                          )}
                          {o.payment_terms && (
                            <div className="mt-1">
                              <span className="font-semibold text-slate-500">TERMS:</span> <span className="text-slate-700">{o.payment_terms}</span>
                            </div>
                          )}
                          {o.special_instructions && (
                            <div className="mt-1">
                              <span className="font-semibold text-slate-500">NOTES:</span> <span className="text-slate-700">{o.special_instructions}</span>
                            </div>
                          )}
                          {!o.billing_address && !o.shipping_address && !o.payment_terms && !o.special_instructions && (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>

                        {/* LINE ITEMS — OCR + LLM + Item-Master matches, fully shown */}
                        <td className="px-2 py-2 text-slate-700 align-top whitespace-normal break-words" style={{ minWidth: 260 }}>
                          {lines.length === 0 ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <>
                              <table className="w-full border border-slate-200" style={{ fontSize: '12px' }}>
                                <thead className="bg-slate-100/70">
                                  <tr>
                                    <th className="px-1 py-0.5 text-left font-semibold border-b border-slate-200">#</th>
                                    <th className="px-1 py-0.5 text-left font-semibold border-b border-slate-200">SKU</th>
                                    <th className="px-1 py-0.5 text-left font-semibold border-b border-slate-200">Item / Description</th>
                                    <th className="px-1 py-0.5 text-right font-semibold border-b border-slate-200">Qty</th>
                                    <th className="px-1 py-0.5 text-left font-semibold border-b border-slate-200">UoM</th>
                                    <th className="px-1 py-0.5 text-right font-semibold border-b border-slate-200">Unit ₹</th>
                                    <th className="px-1 py-0.5 text-right font-semibold border-b border-slate-200">Total</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {lines.map((l, i) => {
                                    return (
                                      <tr key={i} className="border-b border-slate-100 last:border-0">
                                        <td className="px-1 py-0.5 align-top text-slate-500">{l.line_number ?? i + 1}</td>
                                        <td className="px-1 py-0.5 align-top font-mono text-slate-700 break-all whitespace-normal">{l.sku_code || '—'}</td>
                                        <td className="px-1 py-0.5 align-top text-slate-900 whitespace-normal break-words">
                                          <div className="font-medium">{l.sku_name || l.description || '—'}</div>
                                          {l.sku_name && l.description && l.description !== l.sku_name && (
                                            <div className="text-slate-500 whitespace-normal break-words">{l.description}</div>
                                          )}
                                        </td>
                                        <td className="px-1 py-0.5 align-top text-right font-semibold whitespace-nowrap">{l.quantity ?? '—'}</td>
                                        <td className="px-1 py-0.5 align-top text-slate-600 whitespace-nowrap">{l.unit_of_measure || '—'}</td>
                                        <td className="px-1 py-0.5 align-top text-right text-slate-700 whitespace-nowrap">{l.unit_price != null ? Number(l.unit_price).toFixed(2) : '—'}</td>
                                        <td className="px-1 py-0.5 align-top text-right text-slate-700 whitespace-nowrap">{l.line_total != null ? Number(l.line_total).toFixed(2) : '—'}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </>
                          )}
                        </td>

                        {/* DATES */}
                        <td className="px-2 py-2 text-slate-600 align-top whitespace-nowrap">{formatDate(o.order_date)}</td>
                        <td className="px-2 py-2 text-slate-600 align-top whitespace-nowrap">{formatDate(o.delivery_date)}</td>

                        {/* AMOUNTS */}
                        <td className="px-2 py-2 align-top text-right text-slate-700 whitespace-nowrap">{o.subtotal != null ? formatCurrency(o.subtotal) : '—'}</td>
                        <td className="px-2 py-2 align-top text-right text-slate-700 whitespace-nowrap">{o.tax_amount != null ? formatCurrency(o.tax_amount) : '—'}</td>
                        <td className="px-2 py-2 align-top text-right font-semibold text-slate-900 whitespace-nowrap">{formatCurrency(o.total_amount)}</td>

                        {/* STATUS */}
                        <td className="px-2 py-2 align-top">
                          <Badge className={getStatusColor(o.validation_status || 'pending') + ' !text-[12px] !px-1.5 !py-0.5'}>{o.validation_status || 'pending'}</Badge>
                        </td>

                        {/* APPROVAL */}
                        <td className="px-2 py-2 align-top">
                          <div className="flex flex-col gap-0.5">
                            <Badge className={
                              '!text-[12px] !px-1.5 !py-0.5 ' + (
                              ap === 'approved' ? 'bg-green-100 text-green-800' :
                              ap === 'rejected' ? 'bg-red-100 text-red-700' :
                              ap === 'under_review' ? 'bg-amber-100 text-amber-800' :
                              'bg-slate-100 text-slate-600')
                            }>{ap.replace('_', ' ')}</Badge>
                            <div className="flex flex-wrap gap-0.5">
                              {canReview && ap !== 'under_review' && ap !== 'approved' && (
                                <button onClick={() => approveOrderAction(o.id, 'review')} className="px-1.5 py-0.5 rounded text-blue-700 hover:bg-blue-50" style={{ fontSize: '12px' }}>Review</button>
                              )}
                              {canApprove && ap !== 'approved' && (
                                <button onClick={() => approveOrderAction(o.id, 'approve')} className="px-1.5 py-0.5 rounded text-green-700 hover:bg-green-50" style={{ fontSize: '12px' }}>Approve</button>
                              )}
                              {canApprove && ap !== 'rejected' && (
                                <button onClick={() => approveOrderAction(o.id, 'reject')} className="px-1.5 py-0.5 rounded text-red-700 hover:bg-red-50" style={{ fontSize: '12px' }}>Reject</button>
                              )}
                              {src === 'google_drive' && (o.validation_status === 'failed' || lines.length === 0) && (
                                <button
                                  onClick={() => reprocessDocument(o.document_id ?? o.id)}
                                  className="px-1.5 py-0.5 rounded text-amber-700 hover:bg-amber-50"
                                  style={{ fontSize: '12px' }}
                                  title="Re-run OCR + LLM extraction for this document"
                                >
                                  Reprocess
                                </button>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* EXPORT */}
                        <td className="px-2 py-2 align-top">
                          <Badge className={getStatusColor(o.export_status || 'pending') + ' !text-[12px] !px-1.5 !py-0.5'}>{o.export_status || 'pending'}</Badge>
                        </td>
                        <td className="px-2 py-2 text-slate-500 align-top whitespace-nowrap">{formatDate(o.documents?.received_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {newOrders.length > 0 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100">
                <span className="text-sm text-slate-500">
                  Showing {(newOrdersPage - 1) * TABLE_PAGE_SIZE + 1}–{Math.min(newOrdersPage * TABLE_PAGE_SIZE, newOrders.length)} of {newOrders.length.toLocaleString()} orders
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setNewOrdersPage(p => Math.max(1, p - 1))}
                    disabled={newOrdersPage === 1}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-4 h-4" /> Prev
                  </button>
                  <span className="text-sm text-slate-500">{newOrdersPage} / {totalNewOrdersPages}</span>
                  <button
                    onClick={() => setNewOrdersPage(p => Math.min(totalNewOrdersPages, p + 1))}
                    disabled={newOrdersPage === totalNewOrdersPages}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
