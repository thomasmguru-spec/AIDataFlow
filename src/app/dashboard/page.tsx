'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui';
import { formatDate } from '@/lib/utils';
import {
  ShoppingCart,
  Truck,
  CreditCard,
  Users,
  Store,
  TrendingUp,
  DollarSign,
  ArrowRight,
  Boxes,
  FileText,
  ClipboardList,
} from 'lucide-react';
import Link from 'next/link';

interface DashboardStats {
  counts: {
    salesOrders: number;
    purchaseOrders: number;
    payments: number;
    customers: number;
    vendors: number;
    inventoryItems: number;
    newInvoices: number;
    newOrders: number;
  };
  recentSalesOrders: {
    id: string;
    invoiceNumber: string | null;
    requestedDate: string;
    orderTotal: number;
    paymentStatus: string;
    customer: { companyName: string };
  }[];
  recentPayments: {
    id: string;
    amount: number;
    paymentDate: string;
    paymentMethod: string | null;
    isRefund: boolean;
    customer: { companyName: string } | null;
    vendor: { companyName: string } | null;
  }[];
}

function formatCurrency(val: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
}

function formatNumber(val: number) {
  return new Intl.NumberFormat('en-US').format(val);
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/silo/stats')
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error);
        setData(d);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        <span className="ml-3 text-slate-500">Loading Silo data...</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
        <p className="text-red-700 font-medium">Failed to load dashboard</p>
        <p className="text-red-500 text-sm mt-1">{error}</p>
      </div>
    );
  }

  const statCards = [
    { label: 'Sales Orders', value: data.counts.salesOrders, icon: ShoppingCart, gradient: 'from-blue-500 to-blue-700', iconBg: 'bg-white/20', href: '/dashboard/orders' },
    { label: 'Purchase Orders', value: data.counts.purchaseOrders, icon: Truck, gradient: 'from-purple-500 to-purple-700', iconBg: 'bg-white/20', href: '/dashboard/orders' },
    { label: 'Payments', value: data.counts.payments, icon: CreditCard, gradient: 'from-emerald-500 to-emerald-700', iconBg: 'bg-white/20', href: '/dashboard/invoices' },
    { label: 'Customers', value: data.counts.customers, icon: Users, gradient: 'from-amber-500 to-amber-700', iconBg: 'bg-white/20', href: '/dashboard/customers' },
    { label: 'Vendors', value: data.counts.vendors, icon: Store, gradient: 'from-rose-500 to-rose-700', iconBg: 'bg-white/20', href: '/dashboard/vendors' },
    { label: 'Inventory Items', value: data.counts.inventoryItems, icon: Boxes, gradient: 'from-teal-500 to-teal-700', iconBg: 'bg-white/20', href: '/dashboard/inventory' },
    { label: 'New Invoices', value: data.counts.newInvoices, icon: FileText, gradient: 'from-indigo-500 to-indigo-700', iconBg: 'bg-white/20', href: '/dashboard/invoices' },
    { label: 'New Orders', value: data.counts.newOrders, icon: ClipboardList, gradient: 'from-cyan-500 to-cyan-700', iconBg: 'bg-white/20', href: '/dashboard/orders' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
        <p className="text-slate-500 mt-1">Supply Seva — Silo WMS Overview</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <Link key={stat.label} href={stat.href}>
            <div className={`relative overflow-hidden rounded-xl bg-gradient-to-br ${stat.gradient} p-5 shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all duration-200 cursor-pointer group`}>
              {/* Background decorative circle */}
              <div className="absolute -top-4 -right-4 w-24 h-24 rounded-full bg-white/10 group-hover:scale-110 transition-transform duration-300" />
              <div className="absolute -bottom-6 -right-6 w-20 h-20 rounded-full bg-white/5" />
              <div className="relative z-10 flex flex-col items-center justify-center gap-2 py-2">
                <div className={`w-12 h-12 rounded-xl ${stat.iconBg} flex items-center justify-center`}>
                  <stat.icon className="w-6 h-6 text-white" />
                </div>
                <p className="text-2xl font-bold text-white">{formatNumber(stat.value)}</p>
                <p className="text-xs font-semibold text-white/80 tracking-wide">{stat.label}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* Recent Sales Orders + Recent Payments side-by-side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Sales Orders */}
        <Card>
          <CardContent>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-blue-600" />
                <h3 className="font-semibold text-slate-900">Recent Sales Orders</h3>
              </div>
              <Link href="/dashboard/orders" className="text-sm text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1">
                View all <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="space-y-3">
              {data.recentSalesOrders.map((order) => (
                <div key={order.id} className="flex items-center justify-between p-3 rounded-lg bg-slate-50">
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      {order.customer.companyName}
                    </p>
                    <p className="text-xs text-slate-500">
                      {order.invoiceNumber || `#${order.id}`} &middot; {formatDate(order.requestedDate)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-slate-900">{formatCurrency(order.orderTotal)}</p>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      order.paymentStatus === 'PAID' ? 'bg-green-100 text-green-800' :
                      order.paymentStatus === 'PARTIALLY_PAID' ? 'bg-amber-100 text-amber-800' :
                      'bg-slate-100 text-slate-600'
                    }`}>
                      {order.paymentStatus.replace(/_/g, ' ')}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent Payments */}
        <Card>
          <CardContent>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-green-600" />
                <h3 className="font-semibold text-slate-900">Recent Payments</h3>
              </div>
              <Link href="/dashboard/invoices" className="text-sm text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1">
                View all <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="space-y-3">
              {data.recentPayments.map((pay) => (
                <div key={pay.id} className="flex items-center justify-between p-3 rounded-lg bg-slate-50">
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      {pay.customer?.companyName || pay.vendor?.companyName || '—'}
                    </p>
                    <p className="text-xs text-slate-500">
                      {formatDate(pay.paymentDate)} &middot; {pay.paymentMethod || '—'}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-semibold ${pay.isRefund ? 'text-red-600' : 'text-green-700'}`}>
                      {pay.isRefund ? '−' : '+'}{formatCurrency(Math.abs(pay.amount))}
                    </p>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      pay.isRefund ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                    }`}>
                      {pay.isRefund ? 'Refund' : 'Payment'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
