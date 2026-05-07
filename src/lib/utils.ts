import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number | null | undefined, currency = 'USD') {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

export function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

export function formatDateTime(dateStr: string | null | undefined) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatMs(ms: number | null | undefined) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatConfidence(confidence: number | null | undefined) {
  if (confidence == null) return '—';
  return `${(confidence * 100).toFixed(1)}%`;
}

export function getStatusColor(status: string): string {
  const map: Record<string, string> = {
    new: 'bg-blue-100 text-blue-800',
    processing: 'bg-yellow-100 text-yellow-800',
    extracted: 'bg-indigo-100 text-indigo-800',
    validated: 'bg-green-100 text-green-800',
    exception: 'bg-red-100 text-red-800',
    approved: 'bg-emerald-100 text-emerald-800',
    ready_for_export: 'bg-cyan-100 text-cyan-800',
    exported: 'bg-teal-100 text-teal-800',
    failed: 'bg-red-100 text-red-800',
    // Exception & validation statuses
    pending: 'bg-yellow-100 text-yellow-800',
    in_review: 'bg-amber-100 text-amber-800',
    rejected: 'bg-rose-100 text-rose-800',
    passed: 'bg-green-100 text-green-800',
    confirmed: 'bg-teal-100 text-teal-800',
  };
  return map[status] || 'bg-gray-100 text-gray-800';
}

export function getPriorityColor(priority: string): string {
  const map: Record<string, string> = {
    critical: 'bg-red-100 text-red-800',
    high: 'bg-orange-100 text-orange-800',
    medium: 'bg-yellow-100 text-yellow-800',
    low: 'bg-green-100 text-green-800',
  };
  return map[priority] || 'bg-gray-100 text-gray-800';
}
