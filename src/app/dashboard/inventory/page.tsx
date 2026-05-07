'use client';

import { Card } from '@/components/ui';
import { Boxes, RefreshCw, ExternalLink, Search, Download } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';

interface ItemMasterRow {
  id: string;
  sku_code: string | null;
  upc: string | null;
  plu: string | null;
  description: string | null;
  group_name: string | null;
  location: string | null;
  on_hand: number | null;
  unit_price: number | null;
  last_synced_at: string | null;
}

const SILO_URL = 'https://app.usesilo.com';

export default function ItemMasterPage() {
  const [items, setItems] = useState<ItemMasterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [autoSyncTried, setAutoSyncTried] = useState(false);
  const [diag, setDiag] = useState<{ projectRef: string; hasServiceRole: boolean; serviceRoleHash?: string | null; headCount?: number | null; headError?: string | null } | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/item-master?ts=${Date.now()}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      const contentType = res.headers.get('content-type') || '';
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        if (contentType.includes('application/json')) {
          const errJson = await res.json();
          message = errJson.error || message;
        } else if (res.status === 401) {
          message = 'Session expired. Please login again.';
        }
        throw new Error(message);
      }
      if (!contentType.includes('application/json')) {
        throw new Error('Unexpected non-JSON response from item-master API. Please login again.');
      }
      const data = await res.json();
      setItems(data.items || []);
      setDiag(data._diag || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  const syncFromSilo = useCallback(async () => {
    setSyncing(true);
    // Poll item_master while sync runs so the UI fills in incrementally
    // even if the upstream Vercel function gets killed by a timeout
    // (rows are upserted per Silo page, so partial progress survives).
    const pollHandle = setInterval(() => { fetchData(); }, 3000);
    try {
      const res = await fetch(`/api/item-master/sync?ts=${Date.now()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        cache: 'no-store',
        credentials: 'include',
      });
      let json: any = {};
      try { json = await res.json(); } catch { /* timeout / non-JSON */ }
      if (!res.ok || json.ok === false) {
        // Even on timeout/error, the rows that DID land are visible —
        // re-fetch one more time and surface a soft warning.
        await fetchData();
        toast.error(json.error || `Sync failed (HTTP ${res.status}) — partial data may have been saved`);
      } else {
        const po = json.sources?.purchaseOrders;
        const so = json.sources?.salesOrders;
        const detail = po || so
          ? ` (PO: ${po?.pages || 0}p${po?.skipped ? `/${po.skipped} skip` : ''}, SO: ${so?.pages || 0}p${so?.skipped ? `/${so.skipped} skip` : ''})`
          : '';
        toast.success(
          `Synced ${json.upserted} items from Silo in ${(json.duration_ms / 1000).toFixed(1)}s${detail}`
        );
        await fetchData();
      }
    } catch (e) {
      // Network/abort: still refresh to show whatever was saved.
      await fetchData();
      toast.error(e instanceof Error ? e.message : 'Sync request failed');
    } finally {
      clearInterval(pollHandle);
      setSyncing(false);
    }
  }, [fetchData]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-sync: if the table is empty on first load, kick off a Silo sync
  // so the operator never sees a permanently-empty Item Master. Runs at
  // most once per page mount and only after the initial fetch completes.
  useEffect(() => {
    if (loading) return;
    if (autoSyncTried) return;
    if (items.length > 0) return;
    setAutoSyncTried(true);
    toast('Item master is empty — pulling from Silo automatically…', { icon: '⏳' });
    syncFromSilo();
  }, [loading, items.length, autoSyncTried, syncFromSilo]);

  const q = search.toLowerCase();
  const filtered = items.filter(p =>
    (p.description || '').toLowerCase().includes(q) ||
    (p.sku_code || '').toLowerCase().includes(q) ||
    (p.upc || '').toLowerCase().includes(q) ||
    (p.group_name || '').toLowerCase().includes(q) ||
    p.id.toLowerCase().includes(q)
  );

  const lastSynced = items.reduce<string | null>((max, it) => {
    if (!it.last_synced_at) return max;
    if (!max || it.last_synced_at > max) return it.last_synced_at;
    return max;
  }, null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Item Master</h1>
          <p className="text-slate-500 mt-1">
            {items.length} items in master database
            {lastSynced && ` · last synced ${new Date(lastSynced).toLocaleString()}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={syncFromSilo}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg disabled:opacity-50"
            title="Pull every item from Silo and upsert into the item_master table"
          >
            <Download className={`w-4 h-4 ${syncing ? 'animate-pulse' : ''}`} />
            {syncing ? 'Syncing from Silo…' : 'Sync from Silo'}
          </button>
          <button onClick={fetchData} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          <a href={SILO_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-lg transition">
            Open Silo <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          placeholder="Search by SKU, name, UPC, or group..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
        />
      </div>

      {error && <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {items.length === 0 && !loading && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm space-y-1">
          <div>
            {syncing
              ? <>Pulling items from Silo… this usually takes 20–60 seconds.</>
              : <>The item_master table is empty. Click <strong>Sync from Silo</strong> above to populate it.</>}
          </div>
          {diag && (
            <div className="text-xs text-amber-700 font-mono space-y-0.5">
              <div>project: <strong>{diag.projectRef}</strong> · service-role: <strong>{diag.hasServiceRole ? 'present' : 'MISSING'}</strong>{diag.serviceRoleHash ? ` (${diag.serviceRoleHash})` : ''}</div>
              <div>head-count of item_master: <strong>{diag.headCount ?? 'null'}</strong>{diag.headError ? ` · head-error: ${diag.headError}` : ''}</div>
            </div>
          )}
        </div>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-100">
                <th className="px-4 py-3 font-medium">Description</th>
                <th className="px-4 py-3 font-medium">SKU Code</th>
                <th className="px-4 py-3 font-medium">UPC</th>
                <th className="px-4 py-3 font-medium">Group</th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 font-medium text-right">On Hand</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-500">
                  <RefreshCw className="w-6 h-6 text-slate-300 mx-auto mb-2 animate-spin" /> Loading item master...
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-500">
                  <Boxes className="w-8 h-8 text-slate-300 mx-auto mb-2" /> No items found
                </td></tr>
              ) : filtered.map(p => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-slate-900">{p.description || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-700">{p.sku_code || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">{p.upc || '—'}</td>
                  <td className="px-4 py-2 text-slate-600">{p.group_name || '—'}</td>
                  <td className="px-4 py-2 text-slate-600">{p.location || '—'}</td>
                  <td className="px-4 py-2 text-right font-medium">
                    {p.on_hand != null ? Number(p.on_hand).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="px-4 py-3 border-t border-slate-100 text-sm text-slate-500">
            Showing {filtered.length} of {items.length} items
          </div>
        )}
      </Card>
    </div>
  );
}
