import { createServerSupabase } from '@/lib/supabase/server';
import { Card, CardContent, Badge } from '@/components/ui';
import { getStatusColor, formatDateTime, formatCurrency } from '@/lib/utils';
import { Upload } from 'lucide-react';
import { TriggerExportButton } from './trigger-export';

export default async function ExportsPage() {
  const supabase = createServerSupabase();

  // Get exported invoices
  const { data: exportedInvoices } = await supabase
    .from('invoices')
    .select('id, document_id, invoice_number, vendor_name, total_amount, export_status, export_batch_id, export_csv_url, exported_at')
    .not('export_status', 'is', null)
    .neq('export_status', 'pending')
    .order('exported_at', { ascending: false })
    .limit(50);

  // Get exported orders
  const { data: exportedOrders } = await supabase
    .from('orders')
    .select('id, document_id, order_number, customer_name, total_amount, export_status, export_batch_id, export_csv_url, exported_at')
    .not('export_status', 'is', null)
    .neq('export_status', 'pending')
    .order('exported_at', { ascending: false })
    .limit(50);

  // Combine and sort by exported_at
  const allExports = [
    ...(exportedInvoices || []).map((inv) => ({ ...inv, type: 'invoice', reference: inv.invoice_number, party: inv.vendor_name })),
    ...(exportedOrders || []).map((ord) => ({ ...ord, type: 'order', reference: ord.order_number, party: ord.customer_name })),
  ].sort((a, b) => new Date(b.exported_at || 0).getTime() - new Date(a.exported_at || 0).getTime());

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Silo WMS Exports</h1>
          <p className="text-slate-500 mt-1">CSV exports to Silo WMS</p>
        </div>
        <TriggerExportButton />
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-100">
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Reference</th>
                <th className="px-6 py-3 font-medium">Party</th>
                <th className="px-6 py-3 font-medium">Amount</th>
                <th className="px-6 py-3 font-medium">Batch ID</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Exported</th>
                <th className="px-6 py-3 font-medium">CSV</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {allExports.map((exp) => (
                <tr key={exp.id} className="hover:bg-slate-50">
                  <td className="px-6 py-3 capitalize">{exp.type}</td>
                  <td className="px-6 py-3 font-medium">{exp.reference || '—'}</td>
                  <td className="px-6 py-3">{exp.party || '—'}</td>
                  <td className="px-6 py-3">{formatCurrency(exp.total_amount)}</td>
                  <td className="px-6 py-3 font-mono text-xs">{exp.export_batch_id || '—'}</td>
                  <td className="px-6 py-3">
                    <Badge className={getStatusColor(exp.export_status || '')}>{exp.export_status}</Badge>
                  </td>
                  <td className="px-6 py-3 text-slate-500">{formatDateTime(exp.exported_at)}</td>
                  <td className="px-6 py-3">
                    {exp.export_csv_url && (
                      <a href={exp.export_csv_url} target="_blank" rel="noopener noreferrer"
                        className="text-brand-600 hover:underline text-xs">Download</a>
                    )}
                  </td>
                </tr>
              ))}
              {allExports.length === 0 && (
                <tr><td colSpan={8} className="px-6 py-12 text-center text-slate-500">
                  <Upload className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                  No exports yet
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
