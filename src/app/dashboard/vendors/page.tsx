'use client';

import { Card, Badge } from '@/components/ui';
import { Truck, RefreshCw, ExternalLink, MapPin, Phone, Search } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

interface SiloVendor {
  id: string;
  companyName: string;
  legalName: string;
  addresses: { id: string; name: string | null; phone: string | null; street1: string; street2: string | null; city: string; state: string; post: string; country: string }[];
  contacts: { id: string; name: string | null; phoneNumber: string | null; faxNumber: string | null; emailAddress: string | null }[];
}

const SILO_URL = 'https://app.usesilo.com';

export default function VendorsPage() {
  const [vendors, setVendors] = useState<SiloVendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/silo/vendors');
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const data = await res.json();
      setVendors(data.vendors);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filtered = vendors.filter(v =>
    v.companyName.toLowerCase().includes(search.toLowerCase()) ||
    (v.legalName || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Vendors</h1>
          <p className="text-slate-500 mt-1">{vendors.length} vendors from Silo WMS</p>
        </div>
        <div className="flex items-center gap-2">
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
          placeholder="Search vendors..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
        />
      </div>

      {error && <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-100">
                <th className="px-6 py-3 font-medium">Company Name</th>
                <th className="px-6 py-3 font-medium">Legal Name</th>
                <th className="px-6 py-3 font-medium">Address</th>
                <th className="px-6 py-3 font-medium">Phone</th>
                <th className="px-6 py-3 font-medium">Contact Person</th>
                <th className="px-6 py-3 font-medium">Email</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                  <RefreshCw className="w-6 h-6 text-slate-300 mx-auto mb-2 animate-spin" /> Loading vendors...
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                  <Truck className="w-8 h-8 text-slate-300 mx-auto mb-2" /> No vendors found
                </td></tr>
              ) : filtered.map(v => {
                const addr = v.addresses?.[0];
                const contact = v.contacts?.[0];
                return (
                  <tr key={v.id} className="hover:bg-slate-50">
                    <td className="px-6 py-3 font-medium text-slate-900">{v.companyName}</td>
                    <td className="px-6 py-3 text-slate-600">{v.legalName || '—'}</td>
                    <td className="px-6 py-3 text-slate-600 max-w-[200px]">
                      {addr ? (
                        <div className="flex items-start gap-1">
                          <MapPin className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" />
                          <span className="truncate">{addr.street1}, {addr.city}, {addr.state} {addr.post}</span>
                        </div>
                      ) : '—'}
                    </td>
                    <td className="px-6 py-3 text-slate-600">
                      {contact?.phoneNumber ? (
                        <div className="flex items-center gap-1"><Phone className="w-3.5 h-3.5 text-slate-400" />{contact.phoneNumber}</div>
                      ) : addr?.phone ? (
                        <div className="flex items-center gap-1"><Phone className="w-3.5 h-3.5 text-slate-400" />{addr.phone}</div>
                      ) : '—'}
                    </td>
                    <td className="px-6 py-3 text-slate-600">{contact?.name || '—'}</td>
                    <td className="px-6 py-3 text-slate-600 text-xs">{contact?.emailAddress || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="px-6 py-3 border-t border-slate-100 text-sm text-slate-500">
            Showing {filtered.length} of {vendors.length} vendors
          </div>
        )}
      </Card>
    </div>
  );
}
