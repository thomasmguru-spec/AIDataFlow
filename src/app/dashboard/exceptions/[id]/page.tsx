import { createServerSupabase } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, Badge } from '@/components/ui';
import { getStatusColor, getPriorityColor, formatDateTime, formatCurrency } from '@/lib/utils';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileText, ExternalLink } from 'lucide-react';
import { ExceptionReviewForm } from './review-form';

// This page receives document_id as the param
export default async function ExceptionDetailPage({ params }: { params: { id: string } }) {
  const supabase = createServerSupabase();

  const { data: doc } = await supabase
    .from('documents')
    .select('*')
    .eq('id', params.id)
    .single();

  if (!doc) notFound();

  const [
    { data: invoice },
    { data: order },
  ] = await Promise.all([
    supabase.from('invoices').select('*, invoice_lines(*)').eq('document_id', doc.id).maybeSingle(),
    supabase.from('orders').select('*, order_lines(*)').eq('document_id', doc.id).maybeSingle(),
  ]);

  // Get exception data from whichever record exists
  const record = invoice || order;
  if (!record || !record.exception_status) notFound();

  const failedChecks = ((record.validation_checks ?? []) as Array<{
    check_name: string; passed: boolean; message: string | null; field_name: string | null;
    expected_value: string | null; actual_value: string | null; severity: string;
  }>).filter(c => !c.passed);

  const comments = (record.exception_comments ?? []) as Array<{
    user_id: string; user_name: string; comment: string; created_at: string;
  }>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard/exceptions" className="p-2 rounded-lg hover:bg-slate-100 transition">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">Exception Review</h1>
            <Badge className={getPriorityColor(record.exception_priority ?? '')}>{record.exception_priority}</Badge>
            <Badge className={getStatusColor(record.exception_status ?? '')}>{record.exception_status}</Badge>
          </div>
          <p className="text-slate-500 mt-1">{record.exception_reason}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Original Document */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <h3 className="font-semibold text-slate-900">Original Document</h3>
            </CardHeader>
            <CardContent>
              {doc.file_url ? (
                <div>
                  {doc.file_mime_type?.includes('image') ? (
                    <img src={doc.file_url} alt="Document" className="w-full rounded-lg border" />
                  ) : (
                    <div className="flex flex-col items-center py-8">
                      <FileText className="w-16 h-16 text-slate-300 mb-3" />
                      <p className="text-sm text-slate-500">{doc.original_filename || 'PDF Document'}</p>
                    </div>
                  )}
                  <a
                    href={doc.file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-brand-600 hover:text-brand-700 mt-3"
                  >
                    <ExternalLink className="w-4 h-4" /> Open full document
                  </a>
                </div>
              ) : (
                <p className="text-sm text-slate-500">Document not available</p>
              )}
            </CardContent>
          </Card>

          {/* Failed Validations */}
          {failedChecks.length > 0 && (
            <Card>
              <CardHeader>
                <h3 className="font-semibold text-slate-900">Failed Checks</h3>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {failedChecks.map((v, idx) => (
                    <div key={idx} className="p-3 bg-red-50 rounded-lg text-sm">
                      <p className="font-medium text-red-800">{v.check_name}</p>
                      {v.message && <p className="text-red-600 text-xs mt-1">{v.message}</p>}
                      <div className="flex gap-4 mt-1 text-xs text-red-500">
                        {v.field_name && <span>Field: {v.field_name}</span>}
                        {v.expected_value && <span>Expected: {v.expected_value}</span>}
                        {v.actual_value && <span>Got: {v.actual_value}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Comments (from JSONB array) */}
          <Card>
            <CardHeader>
              <h3 className="font-semibold text-slate-900">Comments</h3>
            </CardHeader>
            <CardContent>
              {comments.length > 0 ? (
                <div className="space-y-3">
                  {comments.map((c, idx) => (
                    <div key={idx} className="p-3 bg-slate-50 rounded-lg">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-sm font-medium text-slate-700">
                          {c.user_name || 'User'}
                        </span>
                        <span className="text-xs text-slate-400">{formatDateTime(c.created_at)}</span>
                      </div>
                      <p className="text-sm text-slate-600">{c.comment}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">No comments yet</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: Editable extracted data + review form */}
        <div className="space-y-4">
          <ExceptionReviewForm
            record={record}
            isInvoice={!!invoice}
            documentId={doc.id}
          />
        </div>
      </div>
    </div>
  );
}
