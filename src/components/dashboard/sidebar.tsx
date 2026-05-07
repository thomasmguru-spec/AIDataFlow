'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  FileText,
  AlertTriangle,
  Package,
  Upload,
  ClipboardList,
  Settings,
  LogOut,
  Menu,
  X,
  Users,
  Truck,
  Boxes,
  ScrollText,
  ExternalLink,
  ShieldCheck,
  KeyRound,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';

const SILO_URL = 'https://app.usesilo.com/';

const navigation = [
  { name: 'Overview', href: '/dashboard', icon: LayoutDashboard, adminOnly: false },
  { name: 'Orders', href: '/dashboard/orders', icon: Package, adminOnly: false },
  { name: 'Invoices', href: '/dashboard/invoices', icon: ClipboardList, adminOnly: false },
  { name: 'Exceptions', href: '/dashboard/exceptions', icon: AlertTriangle, adminOnly: false },
  { name: 'Customers', href: '/dashboard/customers', icon: Users, adminOnly: false },
  { name: 'Vendors', href: '/dashboard/vendors', icon: Truck, adminOnly: false },
  { name: 'Inventory Master', href: '/dashboard/inventory', icon: Boxes, adminOnly: false },
  { name: 'Silo Export', href: '/dashboard/exports', icon: Upload, adminOnly: false },
  { name: 'Documents', href: '/dashboard/documents', icon: FileText, adminOnly: false },
  { name: 'Audit Log', href: '/dashboard/audit', icon: ScrollText, adminOnly: false },
  { name: 'System Users', href: '/dashboard/users', icon: ShieldCheck, adminOnly: true },
  { name: 'Permissions', href: '/dashboard/permissions', icon: KeyRound, adminOnly: true },
  { name: 'Settings', href: '/dashboard/settings', icon: Settings, adminOnly: false },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [role, setRole] = useState<string>('user');

  useEffect(() => {
    fetch('/api/me')
      .then((r) => r.json())
      .then((j) => {
        if (j.user?.role) setRole(j.user.role);
      })
      .catch(() => { /* ignore */ });
  }, []);

  const isAdmin = role === 'admin';
  const visibleNav = navigation.filter((n) => !n.adminOnly || isAdmin);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    toast.success('Logged out');
    router.push('/login');
    router.refresh();
  }

  const navContent = (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-6 py-5 border-b border-slate-200">
        <div className="w-9 h-9 rounded-lg bg-brand-600 text-white flex items-center justify-center font-bold text-lg">
          S
        </div>
        <div>
          <h2 className="font-semibold text-slate-900 text-sm">Supply Seva</h2>
          <p className="text-xs text-slate-500">Document Processing</p>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {visibleNav.map((item) => {
          const isActive =
            item.href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition',
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              )}
            >
              <item.icon className="w-5 h-5 flex-shrink-0" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 py-4 border-t border-slate-200">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-red-50 hover:text-red-700 transition w-full"
        >
          <LogOut className="w-5 h-5" />
          Sign Out
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-white shadow-md border border-slate-200"
      >
        {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/30 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed lg:static inset-y-0 left-0 z-40 w-64 bg-white border-r border-slate-200 transition-transform lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {navContent}
      </aside>
    </>
  );
}
