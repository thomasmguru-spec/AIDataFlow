'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, Badge } from '@/components/ui';
import { formatDateTime } from '@/lib/utils';
import { ScrollText, RefreshCw, Filter, ChevronDown, ChevronRight } from 'lucide-react';

interface AuditEntry {
  id: string;
  table_name: string;
  record_id: string;
  action: string;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  changed_fields: string[] | null;
  performed_by: string | null;
  performed_at: string;
}

const ACTION_COLORS: Record<string, string> = {
  INSERT: 'bg-green-100 text-green-800',
  UPDATE: 'bg-amber-100 text-amber-800',
  DELETE: 'bg-red-100 text-red-800',
};

const TABLE_LABELS: Record<string, string> = {
  documents: 'Document',
  invoices: 'Invoice',
  invoice_lines: 'Invoice Line',
  orders: 'Order',
  order_lines: 'Order Line',
  users: 'User',
};

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tableFilter, setTableFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      if (tableFilter) params.set('table', tableFilter);
      if (actionFilter) params.set('action', actionFilter);
      const res = await fetch(`/api/audit?${params}`);
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const json = await res.json();
      setEntries(json.data || []);
      setTotal(json.total || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch audit log');
    } finally {
      setLoading(false);
    }
  }, [tableFilter, actionFilter, page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function formatChangedFields(entry: AuditEntry): string {
    if (!entry.changed_fields || entry.changed_fields.length === 0) return '';
    return entry.changed_fields.join(', ');
  }

  function getRecordLabel(entry: AuditEntry): string {
    const data = entry.new_data || entry.old_data;
    if (!data) return entry.record_id.slice(0, 8);
    // Try to find a meaningful label
    const label =
      (data.original_filename as string) ||
      (data.invoice_number as string) ||
      (data.order_number as string) ||
      (data.email as string) ||
      (data.vendor_name as string) ||
      (data.customer_name as string);
    return label || entry.record_id.slice(0, 8);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Audit Log</h1>
          <p className="text-slate-500 mt-1">
            {total.toLocaleString()} total entries — every insert, update, and delete is tracked
          </p>
        </div>
        <button onClick={fetchData} disabled={loading} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-sm text-slate-500">
          <Filter className="w-4 h-4" />
          <span>Filter:</span>
        </div>
        <select
          value={tableFilter}
          onChange={e => { setTableFilter(e.target.value); setPage(0); }}
          className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-brand-500 outline-none"
        >
          <option value="">All Tables</option>
          <option value="documents">Documents</option>
          <option value="invoices">Invoices</option>
          <option value="invoice_lines">Invoice Lines</option>
          <option value="orders">Orders</option>
          <option value="order_lines">Order Lines</option>
          <option value="users">Users</option>
        </select>
        <select
          value={actionFilter}
          onChange={e => { setActionFilter(e.target.value); setPage(0); }}
          className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-brand-500 outline-none"
        >
          <option value="">All Actions</option>
          <option value="INSERT">INSERT</option>
          <option value="UPDATE">UPDATE</option>
          <option value="DELETE">DELETE</option>
        </select>
      </div>

      {error && <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-100">
                <th className="px-6 py-3 font-medium w-8"></th>
                <th className="px-6 py-3 font-medium">Timestamp</th>
                <th className="px-6 py-3 font-medium">Table</th>
                <th className="px-6 py-3 font-medium">Record</th>
                <th className="px-6 py-3 font-medium">Action</th>
                <th className="px-6 py-3 font-medium">Changed Fields</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && entries.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                  <RefreshCw className="w-6 h-6 text-slate-300 mx-auto mb-2 animate-spin" /> Loading audit log...
                </td></tr>
              ) : entries.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                  <ScrollText className="w-8 h-8 text-slate-300 mx-auto mb-2" /> No audit entries found
                </td></tr>
              ) : entries.map(entry => (
                <>
                  <tr
                    key={entry.id}
                    className="hover:bg-slate-50 cursor-pointer"
                    onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                  >
                    <td className="px-6 py-3">
                      {expandedId === entry.id ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                    </td>
                    <td className="px-6 py-3 text-slate-600 whitespace-nowrap">{formatDateTime(entry.performed_at)}</td>
                    <td className="px-6 py-3">
                      <Badge className="bg-slate-100 text-slate-700">{TABLE_LABELS[entry.table_name] || entry.table_name}</Badge>
                    </td>
                    <td className="px-6 py-3 text-slate-700 font-medium max-w-[200px] truncate">
                      {getRecordLabel(entry)}
                    </td>
                    <td className="px-6 py-3">
                      <Badge className={ACTION_COLORS[entry.action] || 'bg-slate-100 text-slate-700'}>{entry.action}</Badge>
                    </td>
                    <td className="px-6 py-3 text-slate-500 text-xs max-w-[300px] truncate">
                      {formatChangedFields(entry) || (entry.action === 'INSERT' ? 'New record' : entry.action === 'DELETE' ? 'Record removed' : '—')}
                    </td>
                  </tr>
                  {expandedId === entry.id && (
                    <tr key={`${entry.id}-detail`}>
                      <td colSpan={6} className="px-6 py-4 bg-slate-50">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                          {entry.action !== 'INSERT' && entry.old_data && (
                            <div>
                              <p className="font-semibold text-slate-700 mb-1">Old Data</p>
                              <pre className="bg-white p-3 rounded border border-slate-200 overflow-auto max-h-48 text-slate-600">
                                {JSON.stringify(entry.old_data, null, 2)}
                              </pre>
                            </div>
                          )}
                          {entry.action !== 'DELETE' && entry.new_data && (
                            <div>
                              <p className="font-semibold text-slate-700 mb-1">New Data</p>
                              <pre className="bg-white p-3 rounded border border-slate-200 overflow-auto max-h-48 text-slate-600">
                                {JSON.stringify(entry.new_data, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                        <div className="mt-2 text-xs text-slate-400">
                          Record ID: {entry.record_id}
                          {entry.performed_by && <> &middot; User: {entry.performed_by}</>}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {entries.length > 0 && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-slate-100">
            <p className="text-sm text-slate-500">
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
                className="px-3 py-1 text-sm border border-slate-200 rounded-lg disabled:opacity-50 hover:bg-slate-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={(page + 1) * PAGE_SIZE >= total || loading}
                className="px-3 py-1 text-sm border border-slate-200 rounded-lg disabled:opacity-50 hover:bg-slate-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
