'use client';

import { Card, Badge } from '@/components/ui';
import { formatCurrency, formatDate, getStatusColor } from '@/lib/utils';
import { DollarSign, RefreshCw, ExternalLink, ChevronRight, Search, Mail, ScanLine, Cloud, FileText, Image as ImageIcon, Play, ChevronDown, ChevronUp, Send, MessageCircle, X } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { InvoiceEditModal } from '@/components/dashboard/invoice-edit-modal';

interface SiloPayment {
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

interface NewInvoice {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  vendor_name: string | null;
  vendor_code: string | null;
  vendor_address: string | null;
  bill_to_name: string | null;
  bill_to_address: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  payment_terms: string | null;
  validation_status: string | null;
  exception_status: string | null;
  export_status: string | null;
  exported_at: string | null;
  approval_status: string | null;
  rejection_reason: string | null;
  created_at: string;
  documents: {
    id: string;
    source: string;
    original_filename: string;
    received_at: string;
    source_identifier: string | null;
    file_url: string | null;
    file_mime_type: string | null;
    ocr_raw_text: string | null;
    ocr_confidence: number | null;
  };
  lines: InvoiceLine[];
}

interface InvoiceLine {
  invoice_id: string;
  line_number: number;
  description: string | null;
  sku_code: string | null;
  sku_name: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
}

interface GDriveDoc {
  id: string;
  source_identifier: string | null;
  original_filename: string | null;
  file_url: string | null;
  file_mime_type: string | null;
  file_size_bytes: number | null;
  status: string;
  received_at: string;
  created_at: string;
  ocr_raw_text: string | null;
  ocr_confidence: number | null;
  document_type: string | null;
  invoice: {
    id: string;
    invoice_number: string | null;
    invoice_date: string | null;
    due_date: string | null;
    vendor_name: string | null;
    vendor_code: string | null;
    bill_to_name: string | null;
    subtotal: number | null;
    tax_amount: number | null;
    total_amount: number | null;
    payment_terms: string | null;
    validation_status: string | null;
    export_status: string | null;
    exported_at: string | null;
    approval_status: string | null;
    rejection_reason: string | null;
    lines: InvoiceLine[];
  } | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

const SOURCE_ICONS: Record<string, typeof Mail> = {
  email: Mail,
  scanner: ScanLine,
  google_drive: Cloud,
  cloud_upload: Cloud,
};

const SOURCE_LABELS: Record<string, string> = {
  email: 'Email',
  scanner: 'Scanner',
  google_drive: 'Google Drive',
  cloud_upload: 'Upload',
};

const SILO_URL = 'https://app.usesilo.com';
const PAGE_SIZE = 50;

export default function InvoicesPage() {
  const [mainTab, setMainTab] = useState<'silo' | 'new' | 'gdrive' | 'vendor_gdrive'>('new');
  const [payments, setPayments] = useState<SiloPayment[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [pageInfo, setPageInfo] = useState<PageInfo>({ hasNextPage: false, endCursor: null });
  const [newInvoices, setNewInvoices] = useState<NewInvoice[]>([]);
  const [newInvoicesTotal, setNewInvoicesTotal] = useState(0);
  const [newInvoicesSource, setNewInvoicesSource] = useState('');
  const [newInvoicesPage, setNewInvoicesPage] = useState(1);
  const NEW_INVOICES_PAGE_SIZE = 10;
  const [gdriveDocs, setGdriveDocs] = useState<GDriveDoc[]>([]);
  const [gdriveTotal, setGdriveTotal] = useState(0);
  const [gdrivePage, setGdrivePage] = useState(1);
  const [vendorDocs, setVendorDocs] = useState<GDriveDoc[]>([]);
  const [vendorTotal, setVendorTotal] = useState(0);
  const [vendorPage, setVendorPage] = useState(1);
  const [gdriveSyncing, setGdriveSyncing] = useState(false);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [processingDocId, setProcessingDocId] = useState<string | null>(null);
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [siloChecking, setSiloChecking] = useState(false);
  const [myRole, setMyRole] = useState<'admin' | 'manager' | 'validator' | 'user'>('user');
  const [siloLookupRunning, setSiloLookupRunning] = useState(false);
  const [editingInvoiceId, setEditingInvoiceId] = useState<string | null>(null);
  const [postingApproved, setPostingApproved] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<{ url: string; title: string } | null>(null);

  // Capability helpers (mirror src/lib/auth/permissions.ts)
  const canEdit    = ['admin', 'manager', 'validator'].includes(myRole);
  const canReview  = ['admin', 'manager', 'validator'].includes(myRole);
  const canApprove = ['admin', 'manager'].includes(myRole);

  useEffect(() => {
    fetch('/api/me')
      .then((r) => r.json())
      .then((j) => { if (j.user?.role) setMyRole(j.user.role); })
      .catch(() => { /* ignore */ });
  }, []);

  async function approveAction(invId: string, action: 'review' | 'approve' | 'reject', onSuccess?: () => void) {
    let reason: string | null = null;
    if (action === 'reject') {
      reason = window.prompt('Rejection reason?') || null;
      if (reason === null) return;
    }
    const r = await fetch(`/api/invoices/${invId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason }),
    });
    const j = await r.json();
    if (!r.ok) { toast.error(j.error || 'Action failed'); return; }
    toast.success(`Invoice ${action === 'review' ? 'sent for review' : action + 'd'}`);
    fetchNewInvoices();
    onSuccess?.();
  }

  async function postApprovedToSilo() {
    if (!confirm('Post all APPROVED & validated records to Silo? This will use Test Date 1000-01-01 as a marker for the trial run.')) return;
    setPostingApproved(true);
    try {
      const r = await fetch('/api/export/silo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'test_approved' }),
      });
      const j = await r.json();
      if (!r.ok) { toast.error(j.error || 'Posting failed'); return; }
      toast.success(`Posted ${j.invoiceCount ?? 0} invoice(s) and ${j.orderCount ?? 0} order(s) to Silo (batch ${j.batchId})`, { duration: 6000 });
      fetchNewInvoices();
    } finally {
      setPostingApproved(false);
    }
  }

  async function runSiloLookup() {
    setSiloLookupRunning(true);
    try {
      const r = await fetch('/api/silo/lookup', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) { toast.error(j.error || 'Lookup failed'); return; }
      toast.success(
        `Silo sync: ${j.orders?.matched ?? 0} orders + ${j.invoices?.matched ?? 0} invoices matched, ${j.customersCreated ?? 0} created`,
        { duration: 6000 }
      );
      fetchNewInvoices();
    } finally {
      setSiloLookupRunning(false);
    }
  }

  const fetchSiloPayments = useCallback(async (after?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '500' });
      if (after) params.set('after', after);
      const res = await fetch(`/api/silo/payments?${params}`);
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const data = await res.json();
      setPayments(data.edges.map((e: { node: SiloPayment }) => e.node));
      setTotalCount(data.totalCount);
      setPageInfo(data.pageInfo);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchNewInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (newInvoicesSource) params.set('source', newInvoicesSource);
      const res = await fetch(`/api/invoices/new?${params}`);
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const json = await res.json();
      const allInvoices: NewInvoice[] = json.data || [];
      const filtered = allInvoices.filter(inv => {
        const clientName = (inv.bill_to_name || inv.vendor_name || '').trim().toLowerCase();
        return clientName !== 'sankaj';
      });
      setNewInvoices(filtered);
      setNewInvoicesTotal(filtered.length);
      setNewInvoicesPage(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch new invoices');
    } finally {
      setLoading(false);
    }
  }, [newInvoicesSource]);

  const fetchGdriveDocs = useCallback(async (page: number, kind: 'customer_invoices' | 'vendor_invoices' = 'customer_invoices') => {
    setLoading(true);
    setError(null);
    try {
      const perPage = 20;
      const offset = (page - 1) * perPage;
      const res = await fetch(`/api/invoices/gdrive?limit=${perPage}&offset=${offset}&folder_kind=${kind}`);
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const json = await res.json();
      if (kind === 'vendor_invoices') {
        setVendorDocs(json.data || []);
        setVendorTotal(json.total || 0);
      } else {
        setGdriveDocs(json.data || []);
        setGdriveTotal(json.total || 0);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch Google Drive invoices');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleGdriveSync = useCallback(async (kind: 'customer_invoices' | 'vendor_invoices' = 'customer_invoices') => {
    setGdriveSyncing(true);
    try {
      const res = await fetch(`/api/gdrive/sync?kind=${kind}`);
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Sync failed'); return; }
      if (data.imported > 0) {
        toast.success(`Synced ${data.imported} new ${kind === 'vendor_invoices' ? 'vendor' : ''} invoice image(s) from Google Drive`);
        if (kind === 'vendor_invoices') fetchGdriveDocs(vendorPage, 'vendor_invoices');
        else fetchGdriveDocs(gdrivePage, 'customer_invoices');
      } else {
        toast.success(`No new files to sync (${data.total_in_folder || 0} files in folder)`);
      }
    } catch { toast.error('Failed to sync with Google Drive'); }
    finally { setGdriveSyncing(false); }
  }, [fetchGdriveDocs, gdrivePage, vendorPage]);

  const handleCheckSilo = useCallback(async () => {
    setSiloChecking(true);
    try {
      const res = await fetch('/api/gdrive/check-silo');
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Silo check failed'); return; }
      if (data.inserted > 0) {
        toast.success(`Found ${data.missing} missing invoices, inserted ${data.inserted}. Matched ${data.matched_with_silo} with Silo.`);
        fetchGdriveDocs(gdrivePage);
      } else {
        toast.success(`All ${data.checked} invoices accounted for. ${data.matched_with_silo} matched with Silo.`);
      }
    } catch { toast.error('Failed to check Silo'); }
    finally { setSiloChecking(false); }
  }, [fetchGdriveDocs, gdrivePage]);

  const handleProcessOcr = useCallback(async (docId: string, kind: 'customer_invoices' | 'vendor_invoices' = 'customer_invoices') => {
    setProcessingDocId(docId);
    try {
      const res = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: docId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'OCR processing failed');
        return;
      }
      toast.success('OCR completed successfully!');
      fetchGdriveDocs(kind === 'vendor_invoices' ? vendorPage : gdrivePage, kind);
    } catch {
      toast.error('Failed to process document');
    } finally {
      setProcessingDocId(null);
    }
  }, [fetchGdriveDocs, gdrivePage, vendorPage]);

  const handleReextract = useCallback(async (invoiceId: string, kind: 'customer_invoices' | 'vendor_invoices' = 'customer_invoices') => {
    setProcessingDocId(invoiceId);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/reextract`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Re-extraction failed');
        return;
      }
      toast.success(`Re-extracted: ${data.linesInserted} line(s), invoice# ${data.invoiceNumber ?? '—'} (${data.source})`);
      fetchGdriveDocs(kind === 'vendor_invoices' ? vendorPage : gdrivePage, kind);
    } catch {
      toast.error('Failed to re-extract');
    } finally {
      setProcessingDocId(null);
    }
  }, [fetchGdriveDocs, gdrivePage, vendorPage]);

  // For documents stuck in "extracted" status (OCR done but no invoice yet)
  const handleDocReextract = useCallback(async (docId: string, kind: 'customer_invoices' | 'vendor_invoices' = 'customer_invoices') => {
    setProcessingDocId(docId);
    try {
      const res = await fetch(`/api/docs/${docId}/reextract`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Re-extraction failed');
        return;
      }
      toast.success(`Extracted: ${data.linesInserted} item(s)${data.invoiceNumber ? `, invoice# ${data.invoiceNumber}` : ''}`);
      fetchGdriveDocs(kind === 'vendor_invoices' ? vendorPage : gdrivePage, kind);
    } catch {
      toast.error('Failed to extract');
    } finally {
      setProcessingDocId(null);
    }
  }, [fetchGdriveDocs, gdrivePage, vendorPage]);

  const handleBatchProcess = useCallback(async (kind: 'customer_invoices' | 'vendor_invoices' = 'customer_invoices') => {
    const docs = kind === 'vendor_invoices' ? vendorDocs : gdriveDocs;
    const unprocessed = docs.filter(d => d.status === 'new' || d.status === 'failed' || d.status === 'exception');
    if (unprocessed.length === 0) { toast.success('All documents on this page are already processed'); return; }
    setBatchProcessing(true);
    let completed = 0;
    let failed = 0;
    for (const doc of unprocessed) {
      setProcessingDocId(doc.id);
      try {
        const res = await fetch('/api/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ document_id: doc.id }),
        });
        if (res.ok) {
          completed++;
          toast.success(`Processed ${completed}/${unprocessed.length}: ${doc.original_filename || doc.id.slice(0, 8)}`, { duration: 2000 });
        } else {
          failed++;
        }
      } catch { failed++; }
      fetchGdriveDocs(kind === 'vendor_invoices' ? vendorPage : gdrivePage, kind);
    }
    setProcessingDocId(null);
    setBatchProcessing(false);
    toast.success(`Batch complete: ${completed} success, ${failed} failed`);
    fetchGdriveDocs(kind === 'vendor_invoices' ? vendorPage : gdrivePage, kind);
  }, [gdriveDocs, vendorDocs, fetchGdriveDocs, gdrivePage, vendorPage]);

  useEffect(() => { fetchGdriveDocs(1, 'customer_invoices'); }, [fetchGdriveDocs]);

  useEffect(() => {
    if (mainTab === 'silo') fetchSiloPayments();
  }, [mainTab, fetchSiloPayments]);

  useEffect(() => {
    if (mainTab === 'new') fetchNewInvoices();
  }, [mainTab, fetchNewInvoices]);

  useEffect(() => {
    if (mainTab === 'gdrive') fetchGdriveDocs(gdrivePage, 'customer_invoices');
  }, [mainTab, gdrivePage, fetchGdriveDocs]);

  useEffect(() => {
    if (mainTab === 'vendor_gdrive') fetchGdriveDocs(vendorPage, 'vendor_invoices');
  }, [mainTab, vendorPage, fetchGdriveDocs]);

  const filtered = payments.filter(p =>
    (p.customer?.companyName || '').toLowerCase().includes(search.toLowerCase()) ||
    (p.vendor?.companyName || '').toLowerCase().includes(search.toLowerCase()) ||
    (p.checkNumber || '').includes(search) ||
    (p.notes || '').toLowerCase().includes(search.toLowerCase())
  );

  const newInvoicesTotalPages = Math.max(1, Math.ceil(newInvoicesTotal / NEW_INVOICES_PAGE_SIZE));
  const paginatedNewInvoices = newInvoices.slice((newInvoicesPage - 1) * NEW_INVOICES_PAGE_SIZE, newInvoicesPage * NEW_INVOICES_PAGE_SIZE);
  const gdriveTotalPages = Math.ceil(gdriveTotal / 20);
  const vendorTotalPages = Math.ceil(vendorTotal / 20);
  const isGdriveTab = mainTab === 'gdrive' || mainTab === 'vendor_gdrive';
  const activeKind: 'customer_invoices' | 'vendor_invoices' =
    mainTab === 'vendor_gdrive' ? 'vendor_invoices' : 'customer_invoices';
  const activeDocs = mainTab === 'vendor_gdrive' ? vendorDocs : gdriveDocs;
  const activeTotal = mainTab === 'vendor_gdrive' ? vendorTotal : gdriveTotal;
  const activePage = mainTab === 'vendor_gdrive' ? vendorPage : gdrivePage;
  const activeTotalPages = mainTab === 'vendor_gdrive' ? vendorTotalPages : gdriveTotalPages;
  const setActivePage = mainTab === 'vendor_gdrive' ? setVendorPage : setGdrivePage;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Invoices & Payments</h1>
          <p className="text-slate-500 mt-1">
            {mainTab === 'silo'
              ? `${totalCount.toLocaleString()} payments from Silo WMS`
              : mainTab === 'new'
                ? `${newInvoicesTotal.toLocaleString()} customer invoices from Email, WhatsApp, Scanner & Cloud`
                : mainTab === 'vendor_gdrive'
                  ? `${vendorTotal.toLocaleString()} vendor invoice images from Google Drive`
                  : `${gdriveTotal.toLocaleString()} invoice images from Google Drive`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isGdriveTab && (
            <>
              <button
                onClick={handleCheckSilo}
                disabled={siloChecking}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${siloChecking ? 'animate-spin' : ''}`} />
                {siloChecking ? 'Checking...' : 'Check Silo'}
              </button>
              <button
                onClick={() => handleBatchProcess(activeKind)}
                disabled={batchProcessing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
              >
                <Play className={`w-4 h-4 ${batchProcessing ? 'animate-pulse' : ''}`} />
                {batchProcessing ? 'Processing...' : 'Process All OCR'}
              </button>
              <button
                onClick={() => handleGdriveSync(activeKind)}
                disabled={gdriveSyncing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${gdriveSyncing ? 'animate-spin' : ''}`} />
                {gdriveSyncing ? 'Syncing...' : (activeKind === 'vendor_invoices' ? 'Sync Vendor Drive' : 'Sync Google Drive')}
              </button>
            </>
          )}
          {!isGdriveTab && (
            <button onClick={() => mainTab === 'silo' ? fetchSiloPayments() : fetchNewInvoices()} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          )}
          {mainTab === 'new' && canApprove && (
            <button
              onClick={postApprovedToSilo}
              disabled={postingApproved}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
              title="Post all approved & validated records to Silo with Test Date 1000-01-01"
            >
              <Send className={`w-4 h-4 ${postingApproved ? 'animate-pulse' : ''}`} />
              {postingApproved ? 'Posting...' : 'Post Approved to Silo'}
            </button>
          )}
          {mainTab === 'new' && myRole === 'admin' && (
            <button
              onClick={runSiloLookup}
              disabled={siloLookupRunning}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition disabled:opacity-50"
              title="Match unmatched customers/vendors against Silo and create missing customers."
            >
              <RefreshCw className={`w-4 h-4 ${siloLookupRunning ? 'animate-spin' : ''}`} />
              {siloLookupRunning ? 'Syncing...' : 'Sync Silo'}
            </button>
          )}
          <a href={SILO_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg transition">
            Open Silo <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      {/* Main Tabs: Google Drive / Vendor Drive / Silo / New */}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-lg w-fit">
        <button
          onClick={() => setMainTab('gdrive')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition flex items-center gap-1.5 ${
            mainTab === 'gdrive' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <ImageIcon className="w-4 h-4" /> Google Drive ({gdriveTotal})
        </button>
        <button
          onClick={() => setMainTab('vendor_gdrive')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition flex items-center gap-1.5 ${
            mainTab === 'vendor_gdrive' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <ImageIcon className="w-4 h-4" /> Vendor Invoices ({vendorTotal})
        </button>
        <button
          onClick={() => setMainTab('silo')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition ${
            mainTab === 'silo' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Silo Payments
        </button>
        <button
          onClick={() => setMainTab('new')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition ${
            mainTab === 'new' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Customer Invoices ({newInvoicesTotal})
        </button>
      </div>

      {error && <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {/* ─── GOOGLE DRIVE INVOICES VIEW (customer + vendor) ─── */}
      {isGdriveTab && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200 bg-slate-50">
                  <th className="px-4 py-3 font-medium">Preview</th>
                  <th className="px-4 py-3 font-medium">Invoice #</th>
                  <th className="px-4 py-3 font-medium">Vendor / Client</th>
                  <th className="px-4 py-3 font-medium">Item Name</th>
                  <th className="px-4 py-3 font-medium text-right">Qty</th>
                  <th className="px-4 py-3 font-medium text-right">Price</th>
                  <th className="px-4 py-3 font-medium text-right">Total Amount</th>
                  <th className="px-4 py-3 font-medium">Date Invoiced</th>
                  <th className="px-4 py-3 font-medium">Date Delivered</th>
                  <th className="px-4 py-3 font-medium">Date Paid</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && activeDocs.length === 0 ? (
                  <tr><td colSpan={12} className="px-6 py-12 text-center text-slate-500">
                    <RefreshCw className="w-6 h-6 text-slate-300 mx-auto mb-2 animate-spin" /> Loading Google Drive invoices...
                  </td></tr>
                ) : activeDocs.length === 0 ? (
                  <tr><td colSpan={12} className="px-6 py-12 text-center text-slate-500">
                    <ImageIcon className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                    No {activeKind === 'vendor_invoices' ? 'vendor ' : ''}Google Drive invoices found. Click &quot;Sync {activeKind === 'vendor_invoices' ? 'Vendor Drive' : 'Google Drive'}&quot; to import.
                  </td></tr>
                ) : activeDocs.map(doc => {
                  const thumbnailUrl = doc.source_identifier
                    ? `https://drive.google.com/thumbnail?id=${doc.source_identifier}&sz=w200`
                    : null;
                  const viewUrl = doc.source_identifier
                    ? `https://drive.google.com/file/d/${doc.source_identifier}/view`
                    : doc.file_url;
                  const isExpanded = expandedDocId === doc.id;
                  const isProcessing = processingDocId === doc.id || (!!doc.invoice?.id && processingDocId === doc.invoice.id);
                  const inv = doc.invoice;
                  const lines = inv?.lines || [];
                  const rowCount = Math.max(lines.length, 1);

                  // Determine status
                  const displayStatus = inv?.export_status === 'exported'
                    ? 'Paid'
                    : inv?.validation_status === 'passed'
                      ? 'Validated'
                      : inv?.validation_status === 'failed'
                        ? 'Exception'
                        : doc.status === 'processed'
                          ? 'Processed'
                          : doc.status === 'failed'
                            ? 'Failed'
                            : doc.status === 'processing'
                              ? 'Processing'
                              : 'Pending';

                  const statusColor = displayStatus === 'Paid'
                    ? 'bg-green-100 text-green-800'
                    : displayStatus === 'Validated'
                      ? 'bg-blue-100 text-blue-800'
                      : displayStatus === 'Exception'
                        ? 'bg-red-100 text-red-700'
                        : displayStatus === 'Processed'
                          ? 'bg-teal-100 text-teal-800'
                          : displayStatus === 'Failed'
                            ? 'bg-red-100 text-red-700'
                            : displayStatus === 'Processing'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-slate-100 text-slate-600';

                  // Build rows: first row has all columns with rowSpan, extra rows only Item/Qty/Price
                  const tableRows: React.ReactNode[] = [];
                  const firstLine = lines[0] || null;

                  tableRows.push(
                    <tr key={doc.id} className="hover:bg-slate-50 transition align-top border-t border-slate-200">
                      {/* Thumbnail */}
                      <td className="px-4 py-3" rowSpan={rowCount}>
                        {thumbnailUrl ? (
                          <button
                            type="button"
                            title="Preview document"
                            onClick={() => viewUrl && setPreviewDoc({ url: `https://drive.google.com/file/d/${doc.source_identifier}/preview`, title: doc.original_filename || 'Preview' })}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={thumbnailUrl}
                              alt={doc.original_filename || ''}
                              className="w-14 h-14 rounded border border-slate-200 object-cover hover:shadow-md hover:scale-105 transition cursor-pointer"
                            />
                          </button>
                        ) : (
                          <div className="w-14 h-14 rounded border border-slate-200 flex items-center justify-center bg-slate-50">
                            <FileText className="w-5 h-5 text-slate-400" />
                          </div>
                        )}
                      </td>
                      {/* Invoice # */}
                      <td className="px-4 py-3 font-medium text-slate-900" rowSpan={rowCount}>
                        {inv?.invoice_number || '—'}
                        <p className="text-xs text-slate-400 font-normal mt-0.5 truncate max-w-[120px]">{doc.original_filename || ''}</p>
                      </td>
                      {/* Location */}
                      <td className="px-4 py-3 text-slate-700 max-w-[150px]" rowSpan={rowCount}>
                        {inv?.bill_to_name || inv?.vendor_name || '—'}
                      </td>
                      {/* Item Name */}
                      <td className="px-4 py-2 text-slate-700 max-w-[220px]">
                        <span className="block truncate" title={firstLine?.sku_name || firstLine?.description || ''}>
                          {firstLine ? (firstLine.sku_name || firstLine.description || '—') : '—'}
                        </span>
                      </td>
                      {/* Qty */}
                      <td className="px-4 py-2 text-right text-slate-700">
                        {firstLine?.quantity != null ? firstLine.quantity : '—'}
                      </td>
                      {/* Price (unit_price) */}
                      <td className="px-4 py-2 text-right text-slate-700 font-medium">
                        {firstLine?.unit_price != null
                          ? formatCurrency(firstLine.unit_price)
                          : firstLine?.line_total != null
                            ? formatCurrency(firstLine.line_total)
                            : lines.length === 0 && inv?.total_amount != null
                              ? formatCurrency(inv.total_amount)
                              : '—'}
                      </td>
                      {/* Total Amount */}
                      <td className="px-4 py-3 text-right font-semibold text-slate-900" rowSpan={rowCount}>
                        {inv?.total_amount != null ? formatCurrency(inv.total_amount) : '—'}
                      </td>
                      {/* Date Invoiced */}
                      <td className="px-4 py-3 text-slate-600" rowSpan={rowCount}>
                        {inv?.invoice_date ? formatDate(inv.invoice_date) : '—'}
                      </td>
                      {/* Date Delivered */}
                      <td className="px-4 py-3 text-slate-600" rowSpan={rowCount}>
                        {inv?.due_date ? formatDate(inv.due_date) : '—'}
                      </td>
                      {/* Date Paid */}
                      <td className="px-4 py-3 text-slate-600" rowSpan={rowCount}>
                        {inv?.exported_at ? formatDate(inv.exported_at) : '—'}
                      </td>
                      {/* Status */}
                      <td className="px-4 py-3" rowSpan={rowCount}>
                        <Badge className={statusColor}>{displayStatus}</Badge>
                      </td>
                      {/* Actions */}
                      <td className="px-4 py-3" rowSpan={rowCount}>
                        <div className="flex flex-col gap-1.5">
                          {(doc.status === 'new' || doc.status === 'failed' || doc.status === 'exception') && (
                            <button
                              onClick={() => handleProcessOcr(doc.id, activeKind)}
                              disabled={isProcessing}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition disabled:opacity-50"
                            >
                              {isProcessing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                              {isProcessing ? 'Processing...' : 'Run OCR'}
                            </button>
                          )}
                          {doc.status === 'extracted' && !inv && canEdit && (
                            <button
                              onClick={() => handleDocReextract(doc.id, activeKind)}
                              disabled={isProcessing}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition disabled:opacity-50"
                            >
                              {isProcessing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                              {isProcessing ? 'Extracting...' : 'Extract'}
                            </button>
                          )}
                          {(doc.status === 'processed' || doc.status === 'validated' || doc.status === 'exported' || doc.status === 'extracted' || doc.status === 'ready_for_export') && canEdit && inv && (
                            <button
                              onClick={() => handleReextract(inv.id, activeKind)}
                              disabled={isProcessing}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-slate-500 hover:bg-slate-600 text-white rounded-lg transition disabled:opacity-50"
                            >
                              {isProcessing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                              {isProcessing ? 'Extracting...' : 'Re-extract'}
                            </button>
                          )}
                          {doc.status === 'processing' && (
                            <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                              <RefreshCw className="w-3 h-3 animate-spin" /> Processing...
                            </span>
                          )}
                          {inv?.approval_status && inv.approval_status !== 'draft' && (
                            <Badge className={
                              inv.approval_status === 'approved' ? 'bg-green-100 text-green-800' :
                              inv.approval_status === 'rejected' ? 'bg-red-100 text-red-700' :
                              'bg-amber-100 text-amber-800'
                            }>
                              {inv.approval_status.replace('_', ' ')}
                            </Badge>
                          )}
                          {inv && (
                            <div className="flex flex-wrap gap-1">
                              {canEdit && (
                                <button
                                  onClick={() => setEditingInvoiceId(inv.id)}
                                  className="text-[11px] px-2 py-0.5 rounded text-slate-700 hover:bg-slate-100"
                                >
                                  Edit
                                </button>
                              )}
                              {canReview && inv.approval_status !== 'under_review' && inv.approval_status !== 'approved' && (
                                <button
                                  onClick={() => approveAction(inv.id, 'review', () => fetchGdriveDocs(activePage, activeKind))}
                                  className="text-[11px] px-2 py-0.5 rounded text-blue-700 hover:bg-blue-50"
                                >
                                  Review
                                </button>
                              )}
                              {canApprove && inv.approval_status !== 'approved' && (
                                <button
                                  onClick={() => approveAction(inv.id, 'approve', () => fetchGdriveDocs(activePage, activeKind))}
                                  className="text-[11px] px-2 py-0.5 rounded text-green-700 hover:bg-green-50"
                                >
                                  Approve
                                </button>
                              )}
                              {canApprove && inv.approval_status !== 'rejected' && (
                                <button
                                  onClick={() => approveAction(inv.id, 'reject', () => fetchGdriveDocs(activePage, activeKind))}
                                  className="text-[11px] px-2 py-0.5 rounded text-red-700 hover:bg-red-50"
                                >
                                  Reject
                                </button>
                              )}
                            </div>
                          )}
                          {doc.ocr_raw_text && (
                            <button
                              onClick={() => setExpandedDocId(isExpanded ? null : doc.id)}
                              className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-0.5"
                            >
                              {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                              {isExpanded ? 'Hide OCR' : 'OCR Text'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );

                  // Additional rows for remaining line items (only Item/Qty/Price cells)
                  for (let li = 1; li < lines.length; li++) {
                    const line = lines[li];
                    tableRows.push(
                      <tr key={`${doc.id}-line-${li}`} className="hover:bg-slate-50 transition align-top">
                        <td className="px-4 py-2 text-slate-700 max-w-[220px]">
                          <span className="block truncate" title={line.sku_name || line.description || ''}>
                            {line.sku_name || line.description || '—'}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right text-slate-700">
                          {line.quantity != null ? line.quantity : '—'}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-700 font-medium">
                          {line.unit_price != null
                            ? formatCurrency(line.unit_price)
                            : line.line_total != null
                              ? formatCurrency(line.line_total)
                              : '—'}
                        </td>
                      </tr>
                    );
                  }

                  return tableRows;
                }).flat()}
              </tbody>
            </table>
            {/* Expanded OCR text shown below table */}
            {expandedDocId && (() => {
              const doc = activeDocs.find(d => d.id === expandedDocId);
              if (!doc?.ocr_raw_text) return null;
              return (
                <div className="px-6 py-4 border-t border-slate-200 bg-slate-50">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-slate-600">
                      OCR Raw Text — {doc.original_filename}
                      {doc.ocr_confidence != null && <span className="ml-2 text-slate-400">({(doc.ocr_confidence * 100).toFixed(0)}% confidence)</span>}
                    </p>
                    <button onClick={() => setExpandedDocId(null)} className="text-xs text-slate-400 hover:text-slate-600">Close</button>
                  </div>
                  <pre className="p-3 bg-white border border-slate-200 rounded-lg text-xs text-slate-700 whitespace-pre-wrap max-h-64 overflow-y-auto font-mono leading-relaxed">
                    {doc.ocr_raw_text}
                  </pre>
                </div>
              );
            })()}
          </div>
          {activeTotalPages > 1 && (
            <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
              <p className="text-sm text-slate-500">Page {activePage} of {activeTotalPages} ({activeTotal} total)</p>
              <div className="flex gap-2">
                {activePage > 1 && (
                  <button onClick={() => setActivePage(activePage - 1)} className="px-3 py-1 rounded-lg border border-slate-300 text-sm hover:bg-slate-50">Previous</button>
                )}
                {activePage < activeTotalPages && (
                  <button onClick={() => setActivePage(activePage + 1)} className="px-3 py-1 rounded-lg border border-slate-300 text-sm hover:bg-slate-50">Next</button>
                )}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ─── SILO PAYMENTS VIEW ─── */}
      {mainTab === 'silo' && (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search by customer, vendor, check #, or notes..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
            />
          </div>

          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-100">
                    <th className="px-6 py-3 font-medium">Date</th>
                    <th className="px-6 py-3 font-medium">Customer / Vendor</th>
                    <th className="px-6 py-3 font-medium">Amount</th>
                    <th className="px-6 py-3 font-medium">Method</th>
                    <th className="px-6 py-3 font-medium">Check #</th>
                    <th className="px-6 py-3 font-medium">Type</th>
                    <th className="px-6 py-3 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading && payments.length === 0 ? (
                    <tr><td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                      <RefreshCw className="w-6 h-6 text-slate-300 mx-auto mb-2 animate-spin" /> Loading payments...
                    </td></tr>
                  ) : filtered.length === 0 ? (
                    <tr><td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                      <DollarSign className="w-8 h-8 text-slate-300 mx-auto mb-2" /> No payments found
                    </td></tr>
                  ) : filtered.map(p => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="px-6 py-3 text-slate-600">{formatDate(p.paymentDate)}</td>
                      <td className="px-6 py-3 max-w-[200px]">
                        {p.customer ? (
                          <div><span className="text-xs text-slate-400">Customer:</span> <span className="text-slate-900 font-medium truncate block">{p.customer.companyName}</span></div>
                        ) : p.vendor ? (
                          <div><span className="text-xs text-slate-400">Vendor:</span> <span className="text-slate-900 font-medium truncate block">{p.vendor.companyName}</span></div>
                        ) : '—'}
                      </td>
                      <td className={`px-6 py-3 font-medium ${p.isRefund ? 'text-red-600' : 'text-slate-900'}`}>
                        {p.isRefund ? '-' : ''}{formatCurrency(p.amount)}
                      </td>
                      <td className="px-6 py-3 text-slate-500 capitalize text-xs">{p.paymentMethod?.replace(/_/g, ' ') || '—'}</td>
                      <td className="px-6 py-3 text-slate-600 font-mono text-xs">{p.checkNumber || '—'}</td>
                      <td className="px-6 py-3">
                        <Badge className={p.isRefund ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-800'}>
                          {p.isRefund ? 'Refund' : 'Payment'}
                        </Badge>
                      </td>
                      <td className="px-6 py-3 text-slate-500 text-xs max-w-[150px] truncate">{p.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {payments.length > 0 && (
              <div className="flex items-center justify-between px-6 py-3 border-t border-slate-100">
                <p className="text-sm text-slate-500">Showing {filtered.length} of {totalCount.toLocaleString()} payments</p>
                {pageInfo.hasNextPage && (
                  <button onClick={() => fetchSiloPayments(pageInfo.endCursor || undefined)} disabled={loading} className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50">
                    Load more <ChevronRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      {/* ─── NEW INVOICES VIEW ─── */}
      {mainTab === 'new' && (
        <>
          {/* Source filter */}
          <div className="flex gap-1 bg-slate-50 p-1 rounded-lg w-fit">
            {[
              { value: '', label: 'All Sources' },
              { value: 'google_drive,scanner', label: 'Google Drive / Scan' },
              { value: 'email', label: 'Email' },
              { value: 'whatsapp', label: 'WhatsApp' },
            ].map(s => (
              <button
                key={s.value}
                onClick={() => { setNewInvoicesSource(s.value); setNewInvoicesPage(1); }}
                className={`px-4 py-2 rounded-md text-sm font-medium transition ${
                  newInvoicesSource === s.value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-100">
                    <th className="px-4 py-3 font-medium">Preview</th>
                    <th className="px-4 py-3 font-medium">Invoice #</th>
                    <th className="px-4 py-3 font-medium">Client Name &amp; Location</th>
                    <th className="px-4 py-3 font-medium">Item Name</th>
                    <th className="px-4 py-3 font-medium text-right">Qty</th>
                    <th className="px-4 py-3 font-medium text-right">Price</th>
                    <th className="px-4 py-3 font-medium text-right">Total Amount</th>
                    <th className="px-4 py-3 font-medium">Date Invoiced</th>
                    <th className="px-4 py-3 font-medium">Date Delivered</th>
                    <th className="px-4 py-3 font-medium">Date Paid</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading && newInvoices.length === 0 ? (
                    <tr><td colSpan={12} className="px-6 py-12 text-center text-slate-500">
                      <RefreshCw className="w-6 h-6 text-slate-300 mx-auto mb-2 animate-spin" /> Loading new invoices...
                    </td></tr>
                  ) : newInvoices.length === 0 ? (
                    <tr><td colSpan={12} className="px-6 py-12 text-center text-slate-500">
                      <FileText className="w-8 h-8 text-slate-300 mx-auto mb-2" /> No new invoices found
                    </td></tr>
                  ) : paginatedNewInvoices.map(inv => {
                    const doc = inv.documents;
                    const src = doc?.source || 'unknown';
                    const lines = inv.lines || [];
                    const rowCount = Math.max(lines.length, 1);

                    const thumbnailUrl = doc?.source_identifier
                      ? `https://drive.google.com/thumbnail?id=${doc.source_identifier}&sz=w200`
                      : null;
                    const viewUrl = doc?.source_identifier
                      ? `https://drive.google.com/file/d/${doc.source_identifier}/view`
                      : doc?.file_url;

                    const displayStatus = inv.export_status === 'exported'
                      ? 'Paid'
                      : inv.validation_status === 'passed'
                        ? 'Validated'
                        : inv.validation_status === 'failed'
                          ? 'Exception'
                          : 'Pending';

                    const statusColor = displayStatus === 'Paid'
                      ? 'bg-green-100 text-green-800'
                      : displayStatus === 'Validated'
                        ? 'bg-blue-100 text-blue-800'
                        : displayStatus === 'Exception'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-slate-100 text-slate-600';

                    const tableRows: React.ReactNode[] = [];
                    const firstLine = lines[0] || null;

                    tableRows.push(
                      <tr key={inv.id} className="hover:bg-slate-50 transition align-top border-t border-slate-200">
                        {/* Thumbnail */}
                        <td className="px-4 py-3" rowSpan={rowCount}>
                          {thumbnailUrl ? (
                            <a href={viewUrl || '#'} target="_blank" rel="noopener noreferrer" title="Open in Google Drive">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={thumbnailUrl}
                                alt={doc?.original_filename || ''}
                                className="w-14 h-14 rounded border border-slate-200 object-cover hover:shadow-md hover:scale-105 transition cursor-pointer"
                              />
                            </a>
                          ) : (
                            <div className="w-14 h-14 rounded border border-slate-200 flex items-center justify-center bg-slate-50">
                              {src === 'email' ? <Mail className="w-5 h-5 text-slate-400" /> : src === 'scanner' ? <ScanLine className="w-5 h-5 text-slate-400" /> : <FileText className="w-5 h-5 text-slate-400" />}
                            </div>
                          )}
                        </td>
                        {/* Invoice # */}
                        <td className="px-4 py-3 font-medium text-slate-900" rowSpan={rowCount}>
                          {inv.invoice_number || '—'}
                          <p className="text-xs text-slate-400 font-normal mt-0.5 truncate max-w-[120px]">{doc?.original_filename || ''}</p>
                        </td>
                        {/* Client Name & Location */}
                        <td className="px-4 py-3 text-slate-700 max-w-[220px]" rowSpan={rowCount}>
                          <div className="font-medium text-slate-900 truncate" title={inv.bill_to_name || inv.vendor_name || ''}>
                            {inv.bill_to_name || inv.vendor_name || '—'}
                          </div>
                          {(inv.bill_to_address || inv.vendor_address) && (
                            <div className="text-xs text-slate-500 truncate" title={inv.bill_to_address || inv.vendor_address || ''}>
                              {inv.bill_to_address || inv.vendor_address}
                            </div>
                          )}
                        </td>
                        {/* Item Name */}
                        <td className="px-4 py-2 text-slate-700 max-w-[220px]">
                          <span className="block truncate" title={firstLine?.sku_name || firstLine?.description || ''}>
                            {firstLine ? (firstLine.sku_name || firstLine.description || '—') : '—'}
                          </span>
                        </td>
                        {/* Qty */}
                        <td className="px-4 py-2 text-right text-slate-700">
                          {firstLine?.quantity != null ? firstLine.quantity : '—'}
                        </td>
                        {/* Price */}
                        <td className="px-4 py-2 text-right text-slate-700 font-medium">
                          {firstLine?.unit_price != null
                            ? formatCurrency(firstLine.unit_price)
                            : firstLine?.line_total != null
                              ? formatCurrency(firstLine.line_total)
                              : lines.length === 0 && inv.total_amount != null
                                ? formatCurrency(inv.total_amount)
                                : '—'}
                        </td>
                        {/* Total Amount (invoice-level, spans all line rows) */}
                        <td className="px-4 py-3 text-right font-semibold text-slate-900" rowSpan={rowCount}>
                          {inv.total_amount != null ? formatCurrency(inv.total_amount) : '—'}
                        </td>
                        {/* Date Invoiced */}
                        <td className="px-4 py-3 text-slate-600" rowSpan={rowCount}>
                          {inv.invoice_date ? formatDate(inv.invoice_date) : '—'}
                        </td>
                        {/* Date Delivered */}
                        <td className="px-4 py-3 text-slate-600" rowSpan={rowCount}>
                          {inv.due_date ? formatDate(inv.due_date) : '—'}
                        </td>
                        {/* Date Paid */}
                        <td className="px-4 py-3 text-slate-600" rowSpan={rowCount}>
                          {inv.exported_at ? formatDate(inv.exported_at) : '—'}
                        </td>
                        {/* Status */}
                        <td className="px-4 py-3" rowSpan={rowCount}>
                          <Badge className={statusColor}>{displayStatus}</Badge>
                        </td>
                        {/* Actions */}
                        <td className="px-4 py-3" rowSpan={rowCount}>
                          <div className="flex flex-col gap-1.5">
                            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                              {src === 'email' ? <Mail className="w-3 h-3" /> : src === 'whatsapp' ? <MessageCircle className="w-3 h-3" /> : src === 'scanner' ? <ScanLine className="w-3 h-3" /> : <Cloud className="w-3 h-3" />}
                              {src === 'email' ? 'Email' : src === 'whatsapp' ? 'WhatsApp' : src === 'scanner' ? 'Scanner' : 'Drive'}
                            </span>
                            {inv.approval_status && inv.approval_status !== 'draft' && (
                              <Badge className={
                                inv.approval_status === 'approved' ? 'bg-green-100 text-green-800' :
                                inv.approval_status === 'rejected' ? 'bg-red-100 text-red-700' :
                                'bg-amber-100 text-amber-800'
                              }>
                                {inv.approval_status.replace('_', ' ')}
                              </Badge>
                            )}
                            <div className="flex flex-wrap gap-1">
                              {canEdit && (
                                <button
                                  onClick={() => setEditingInvoiceId(inv.id)}
                                  className="text-[11px] px-2 py-0.5 rounded text-slate-700 hover:bg-slate-100"
                                >
                                  Edit
                                </button>
                              )}
                              {canReview && inv.approval_status !== 'under_review' && inv.approval_status !== 'approved' && (
                                <button
                                  onClick={() => approveAction(inv.id, 'review')}
                                  className="text-[11px] px-2 py-0.5 rounded text-blue-700 hover:bg-blue-50"
                                >
                                  Review
                                </button>
                              )}
                              {canApprove && inv.approval_status !== 'approved' && (
                                <button
                                  onClick={() => approveAction(inv.id, 'approve')}
                                  className="text-[11px] px-2 py-0.5 rounded text-green-700 hover:bg-green-50"
                                >
                                  Approve
                                </button>
                              )}
                              {canApprove && inv.approval_status !== 'rejected' && (
                                <button
                                  onClick={() => approveAction(inv.id, 'reject')}
                                  className="text-[11px] px-2 py-0.5 rounded text-red-700 hover:bg-red-50"
                                >
                                  Reject
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    );

                    // Additional rows for remaining line items
                    for (let li = 1; li < lines.length; li++) {
                      const line = lines[li];
                      tableRows.push(
                        <tr key={`${inv.id}-line-${li}`} className="hover:bg-slate-50 transition align-top">
                          <td className="px-4 py-2 text-slate-700 max-w-[220px]">
                            <span className="block truncate" title={line.sku_name || line.description || ''}>
                              {line.sku_name || line.description || '—'}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-right text-slate-700">
                            {line.quantity != null ? line.quantity : '—'}
                          </td>
                          <td className="px-4 py-2 text-right text-slate-700 font-medium">
                            {line.unit_price != null
                              ? formatCurrency(line.unit_price)
                              : line.line_total != null
                                ? formatCurrency(line.line_total)
                                : '—'}
                          </td>
                        </tr>
                      );
                    }

                    return tableRows;
                  }).flat()}
                </tbody>
              </table>
            </div>
            {newInvoicesTotal > 0 && (
              <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between gap-4 flex-wrap">
                <p className="text-sm text-slate-500">
                  Showing {Math.min((newInvoicesPage - 1) * NEW_INVOICES_PAGE_SIZE + 1, newInvoicesTotal)}–{Math.min(newInvoicesPage * NEW_INVOICES_PAGE_SIZE, newInvoicesTotal)} of {newInvoicesTotal.toLocaleString()} invoices
                </p>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setNewInvoicesPage(1)}
                    disabled={newInvoicesPage === 1}
                    className="px-2 py-1 rounded text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="First page"
                  >
                    «
                  </button>
                  <button
                    onClick={() => setNewInvoicesPage(p => Math.max(1, p - 1))}
                    disabled={newInvoicesPage === 1}
                    className="px-3 py-1 rounded text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  {Array.from({ length: newInvoicesTotalPages }, (_, i) => i + 1)
                    .filter(p => p === 1 || p === newInvoicesTotalPages || Math.abs(p - newInvoicesPage) <= 2)
                    .reduce<(number | '...')[]>((acc, p, idx, arr) => {
                      if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push('...');
                      acc.push(p);
                      return acc;
                    }, [])
                    .map((item, idx) =>
                      item === '...' ? (
                        <span key={`ellipsis-${idx}`} className="px-2 py-1 text-sm text-slate-400">…</span>
                      ) : (
                        <button
                          key={item}
                          onClick={() => setNewInvoicesPage(item as number)}
                          className={`px-3 py-1 rounded text-sm font-medium transition ${
                            newInvoicesPage === item
                              ? 'bg-brand-600 text-white'
                              : 'text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          {item}
                        </button>
                      )
                    )}
                  <button
                    onClick={() => setNewInvoicesPage(p => Math.min(newInvoicesTotalPages, p + 1))}
                    disabled={newInvoicesPage === newInvoicesTotalPages}
                    className="px-3 py-1 rounded text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                  <button
                    onClick={() => setNewInvoicesPage(newInvoicesTotalPages)}
                    disabled={newInvoicesPage === newInvoicesTotalPages}
                    className="px-2 py-1 rounded text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Last page"
                  >
                    »
                  </button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}

      {editingInvoiceId && (
        <InvoiceEditModal
          invoiceId={editingInvoiceId}
          onClose={() => setEditingInvoiceId(null)}
          onSaved={() => { setEditingInvoiceId(null); fetchNewInvoices(); }}
        />
      )}

      {/* ─── DOCUMENT PREVIEW MODAL ─── */}
      {previewDoc && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setPreviewDoc(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-4xl flex flex-col"
            style={{ maxHeight: '90vh' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 shrink-0">
              <p className="text-sm font-medium text-slate-700 truncate pr-4">{previewDoc.title}</p>
              <button
                onClick={() => setPreviewDoc(null)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-100 transition shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <iframe
              src={previewDoc.url}
              className="w-full rounded-b-xl"
              style={{ minHeight: '70vh' }}
              allow="autoplay"
              title={previewDoc.title}
            />
          </div>
        </div>
      )}
    </div>
  );
}
