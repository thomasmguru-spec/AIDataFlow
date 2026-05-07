'use client';

import { Card, Badge } from '@/components/ui';
import { Users, RefreshCw, ExternalLink, MapPin, Phone, Mail, Search } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

interface SiloCustomer {
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

const SILO_URL = 'https://app.usesilo.com';

export default function CustomersPage() {
  const [customers, setCustomers] = useState<SiloCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/silo/customers');
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      const data = await res.json();
      setCustomers(data.customers);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filtered = customers.filter(c =>
    c.companyName.toLowerCase().includes(search.toLowerCase()) ||
    (c.legalName || '').toLowerCase().includes(search.toLowerCase())
  );

  const active = filtered.filter(c => !c.isDisabled);
  const disabled = filtered.filter(c => c.isDisabled);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
          <p className="text-slate-500 mt-1">
            {customers.length} customers from Silo WMS — {active.length} active
          </p>
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
          placeholder="Search customers..."
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
                <th className="px-6 py-3 font-medium">Address</th>
                <th className="px-6 py-3 font-medium">Phone</th>
                <th className="px-6 py-3 font-medium">Contact</th>
                <th className="px-6 py-3 font-medium">Route</th>
                <th className="px-6 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                  <RefreshCw className="w-6 h-6 text-slate-300 mx-auto mb-2 animate-spin" /> Loading customers...
                </td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                  <Users className="w-8 h-8 text-slate-300 mx-auto mb-2" /> No customers found
                </td></tr>
              ) : filtered.map(c => {
                const addr = c.addresses?.[0];
                const contact = c.customContacts;
                return (
                  <tr key={c.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}>
                    <td className="px-6 py-3">
                      <div className="font-medium text-slate-900">{c.companyName}</div>
                      {c.legalName && <div className="text-xs text-slate-400">{c.legalName}</div>}
                    </td>
                    <td className="px-6 py-3 text-slate-600 max-w-[200px]">
                      {addr ? (
                        <div className="flex items-start gap-1">
                          <MapPin className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" />
                          <span className="truncate">{addr.street1}, {addr.city}, {addr.state} {addr.post}</span>
                        </div>
                      ) : '—'}
                    </td>
                    <td className="px-6 py-3 text-slate-600">
                      {addr?.phone ? (
                        <div className="flex items-center gap-1"><Phone className="w-3.5 h-3.5 text-slate-400" />{addr.phone}</div>
                      ) : '—'}
                    </td>
                    <td className="px-6 py-3 text-slate-600">
                      {contact ? (
                        <div>
                          <div className="text-slate-700">{contact.firstName} {contact.lastName || ''}</div>
                          {contact.email && <div className="flex items-center gap-1 text-xs text-slate-400"><Mail className="w-3 h-3" />{contact.email}</div>}
                        </div>
                      ) : '—'}
                    </td>
                    <td className="px-6 py-3 text-slate-500 text-xs">{c.deliveryRoute?.name || '—'}</td>
                    <td className="px-6 py-3">
                      <Badge className={c.isDisabled ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}>
                        {c.isDisabled ? 'Disabled' : 'Active'}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="px-6 py-3 border-t border-slate-100 text-sm text-slate-500">
            Showing {filtered.length} of {customers.length} customers
          </div>
        )}
      </Card>
    </div>
  );
}
