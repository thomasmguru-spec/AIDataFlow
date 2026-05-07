import { createServerSupabase } from '@/lib/supabase/server';
import { Card, CardContent, Badge } from '@/components/ui';
import { getStatusColor, getPriorityColor, formatDateTime, formatCurrency } from '@/lib/utils';
import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: { status?: string; priority?: string };
}) {
  const supabase = createServerSupabase();
  const filterStatus = searchParams.status || 'pending';

  // Query v_pending_exceptions view for pending/in_review, or query invoices+orders directly for other statuses
  let exceptions: Array<{
    document_id: string;
    record_id: string;
    document_type: string;
    reference_number: string | null;
    original_filename: string | null;
    source: string;
    party_name: string | null;
    total_amount: number | null;
    exception_status: string | null;
    exception_priority: string | null;
    exception_reason: string | null;
    exception_created_at: string | null;
    ocr_confidence: number | null;
  }> = [];

  if (filterStatus === 'pending' || filterStatus === 'in_review') {
    const { data } = await supabase
      .from('v_pending_exceptions')
      .select('*');
    exceptions = (data || []).map((e: any) => ({
      document_id: e.document_id,
      record_id: e.record_id,
      document_type: e.document_type,
      reference_number: e.reference_number,
      original_filename: e.original_filename,
      source: e.source,
      party_name: e.party_name,
      total_amount: e.total_amount,
      exception_status: e.exception_status,
      exception_priority: e.exception_priority,
      exception_reason: e.exception_reason,
      exception_created_at: e.exception_created_at,
      ocr_confidence: e.ocr_confidence,
    }));
  } else {
    // For approved/rejected, query invoices and orders with that exception_status
    const { data: invs } = await supabase
      .from('invoices')
      .select('id, document_id, invoice_number, vendor_name, total_amount, exception_status, exception_priority, exception_reason, created_at, documents(source, document_type, original_filename, ocr_confidence)')
      .eq('exception_status', filterStatus)
      .order('created_at', { ascending: false })
      .limit(50);

    const { data: ords } = await supabase
      .from('orders')
      .select('id, document_id, order_number, customer_name, total_amount, exception_status, exception_priority, exception_reason, created_at, documents(source, document_type, original_filename, ocr_confidence)')
      .eq('exception_status', filterStatus)
      .order('created_at', { ascending: false })
      .limit(50);

    for (const inv of (invs || [])) {
      const d = inv.documents as any;
      exceptions.push({
        document_id: inv.document_id,
        record_id: inv.id,
        document_type: d?.document_type || 'invoice',
        reference_number: inv.invoice_number,
        original_filename: d?.original_filename,
        source: d?.source || '',
        party_name: inv.vendor_name,
        total_amount: inv.total_amount,
        exception_status: inv.exception_status,
        exception_priority: inv.exception_priority,
        exception_reason: inv.exception_reason,
        exception_created_at: inv.created_at,
        ocr_confidence: d?.ocr_confidence,
      });
    }
    for (const ord of (ords || [])) {
      const d = ord.documents as any;
      exceptions.push({
        document_id: ord.document_id,
        record_id: ord.id,
        document_type: d?.document_type || 'order',
        reference_number: ord.order_number,
        original_filename: d?.original_filename,
        source: d?.source || '',
        party_name: ord.customer_name,
        total_amount: ord.total_amount,
        exception_status: ord.exception_status,
        exception_priority: ord.exception_priority,
        exception_reason: ord.exception_reason,
        exception_created_at: ord.created_at,
        ocr_confidence: d?.ocr_confidence,
      });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Exceptions</h1>
        <p className="text-slate-500 mt-1">{exceptions.length} exceptions to review</p>
      </div>

      {/* Status Filters */}
      <Card>
        <CardContent className="py-3">
          <div className="flex flex-wrap gap-2">
            <FilterLink href="/dashboard/exceptions" label="Pending" active={filterStatus === 'pending'} />
            <FilterLink href="/dashboard/exceptions?status=in_review" label="In Review" active={filterStatus === 'in_review'} />
            <FilterLink href="/dashboard/exceptions?status=approved" label="Approved" active={filterStatus === 'approved'} />
            <FilterLink href="/dashboard/exceptions?status=rejected" label="Rejected" active={filterStatus === 'rejected'} />
          </div>
        </CardContent>
      </Card>

      {/* Exception Cards */}
      {exceptions.length > 0 ? (
        <div className="space-y-3">
          {exceptions.map((exc) => (
            <Link key={exc.record_id} href={`/dashboard/exceptions/${exc.document_id}`}>
              <Card className="hover:shadow-md transition cursor-pointer">
                <CardContent className="py-4">
                  <div className="flex items-center gap-4">
                    <div className="flex-shrink-0">
                      <AlertTriangle className={`w-8 h-8 ${
                        exc.exception_priority === 'critical' ? 'text-red-500' :
                        exc.exception_priority === 'high' ? 'text-orange-500' :
                        'text-amber-500'
                      }`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-slate-900 truncate">
                          {exc.reference_number || exc.original_filename || exc.document_id.slice(0, 12)}
                        </p>
                        <Badge className={getPriorityColor(exc.exception_priority ?? '')}>{exc.exception_priority}</Badge>
                        <Badge className={getStatusColor(exc.exception_status ?? '')}>{exc.exception_status}</Badge>
                      </div>
                      <p className="text-sm text-slate-500 mt-1">{exc.exception_reason}</p>
                      <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
                        {exc.party_name && <span>{exc.party_name}</span>}
                        <span className="capitalize">{(exc.source ?? '').replace('_', ' ')}</span>
                        <span>{formatDateTime(exc.exception_created_at)}</span>
                        {exc.total_amount != null && <span>{formatCurrency(exc.total_amount)}</span>}
                      </div>
                    </div>
                    <div className="text-right text-sm">
                      {exc.ocr_confidence != null && (
                        <p className="text-slate-500">
                          {(exc.ocr_confidence * 100).toFixed(1)}% conf
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-12 text-center">
            <AlertTriangle className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500">No exceptions found</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function FilterLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`px-3 py-1 rounded-full text-sm font-medium transition ${
        active ? 'bg-brand-100 text-brand-700' : 'text-slate-500 hover:bg-slate-100'
      }`}
    >
      {label}
    </Link>
  );
}


