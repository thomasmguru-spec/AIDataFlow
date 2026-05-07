import { createServerSupabase } from '@/lib/supabase/server';
import { Card, CardContent, CardHeader, Badge } from '@/components/ui';
import { getStatusColor, formatDateTime, formatCurrency, formatMs, formatConfidence } from '@/lib/utils';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileText, ExternalLink } from 'lucide-react';
import { DocumentActions } from './actions';

export default async function DocumentDetailPage({ params }: { params: { id: string } }) {
  const supabase = createServerSupabase();

  const { data: doc } = await supabase
    .from('documents')
    .select('*')
    .eq('id', params.id)
    .single();

  if (!doc) notFound();

  // Fetch related data in parallel (denormalized — no separate OCR/validation/exception/log tables)
  const [
    { data: invoice },
    { data: order },
  ] = await Promise.all([
    supabase.from('invoices').select('*, invoice_lines(*)').eq('document_id', doc.id).maybeSingle(),
    supabase.from('orders').select('*, order_lines(*)').eq('document_id', doc.id).maybeSingle(),
  ]);

  // Validation checks come from invoice/order JSONB
  const validationChecks = (invoice?.validation_checks ?? order?.validation_checks ?? []) as Array<{
    check_name: string; passed: boolean; message: string | null; field_name: string | null; severity: string;
  }>;

  // Processing log comes from document JSONB
  const processingLog = (doc.processing_log ?? []) as Array<{
    stage: string; status: string; ts: string; details?: Record<string, unknown>;
  }>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard/documents" className="p-2 rounded-lg hover:bg-slate-100 transition">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900">
              {doc.original_filename || doc.id.slice(0, 12)}
            </h1>
            <Badge className={getStatusColor(doc.status)}>{doc.status.replace('_', ' ')}</Badge>
          </div>
          <p className="text-slate-500 mt-1">Document ID: {doc.id}</p>
        </div>
        <DocumentActions documentId={doc.id} currentStatus={doc.status} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Document preview */}
        <div className="lg:col-span-1">
          <Card>
            <CardHeader>
              <h3 className="font-semibold text-slate-900">Original Document</h3>
            </CardHeader>
            <CardContent>
              {doc.file_url ? (
                <div className="space-y-3">
                  {doc.file_mime_type?.includes('image') ? (
                    <img src={doc.file_url} alt="Document" className="w-full rounded-lg border" />
                  ) : (
                    <div className="flex flex-col items-center py-8">
                      <FileText className="w-16 h-16 text-slate-300 mb-3" />
                      <p className="text-sm text-slate-500">PDF Document</p>
                    </div>
                  )}
                  <a
                    href={doc.file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-brand-600 hover:text-brand-700"
                  >
                    <ExternalLink className="w-4 h-4" /> View full document
                  </a>
                </div>
              ) : (
                <p className="text-sm text-slate-500">No file available</p>
              )}
            </CardContent>
          </Card>

          {/* Metadata */}
          <Card className="mt-4">
            <CardHeader>
              <h3 className="font-semibold text-slate-900">Metadata</h3>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <MetaRow label="Source" value={doc.source} />
              <MetaRow label="Type" value={doc.document_type} />
              <MetaRow label="File Size" value={doc.file_size_bytes ? `${(doc.file_size_bytes / 1024).toFixed(1)} KB` : '—'} />
              <MetaRow label="MIME Type" value={doc.file_mime_type || '—'} />
              <MetaRow label="Received" value={formatDateTime(doc.received_at)} />
              <MetaRow label="Processing Time" value={formatMs(doc.total_processing_time_ms)} />
              <MetaRow label="OCR Confidence" value={formatConfidence(doc.ocr_confidence)} />
              {doc.email_sender && <MetaRow label="Email From" value={doc.email_sender} />}
              {doc.whatsapp_sender && <MetaRow label="WhatsApp From" value={doc.whatsapp_sender} />}
              {doc.error_message && (
                <div className="p-2 bg-red-50 rounded text-red-700 text-xs mt-2">{doc.error_message}</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: Extracted data */}
        <div className="lg:col-span-2 space-y-4">
          {/* Invoice Data */}
          {invoice && (
            <Card>
              <CardHeader>
                <h3 className="font-semibold text-slate-900">Invoice Data</h3>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                  <MetaRow label="Invoice #" value={invoice.invoice_number || '—'} />
                  <MetaRow label="Date" value={invoice.invoice_date || '—'} />
                  <MetaRow label="Vendor" value={invoice.vendor_name || '—'} />
                  <MetaRow label="Subtotal" value={formatCurrency(invoice.subtotal)} />
                  <MetaRow label="Tax" value={formatCurrency(invoice.tax_amount)} />
                  <MetaRow label="Total" value={formatCurrency(invoice.total_amount)} />
                  <MetaRow label="Payment Terms" value={invoice.payment_terms || '—'} />
                  <MetaRow label="Due Date" value={invoice.due_date || '—'} />
                </div>

                {invoice.invoice_lines && invoice.invoice_lines.length > 0 && (
                  <div>
                    <h4 className="font-medium text-slate-700 mb-2">Line Items</h4>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-slate-500 border-b">
                          <th className="text-left py-2">#</th>
                          <th className="text-left py-2">Description</th>
                          <th className="text-left py-2">SKU</th>
                          <th className="text-right py-2">Qty</th>
                          <th className="text-right py-2">Price</th>
                          <th className="text-right py-2">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {invoice.invoice_lines.map((item: Record<string, unknown>) => (
                          <tr key={item.id as string}>
                            <td className="py-2">{item.line_number as number}</td>
                            <td className="py-2">{(item.description as string) || '—'}</td>
                            <td className="py-2">
                              <span className={`${item.sku_matched ? 'text-green-600' : 'text-amber-600'}`}>
                                {(item.sku_code as string) || '—'}
                              </span>
                            </td>
                            <td className="py-2 text-right">{item.quantity as number}</td>
                            <td className="py-2 text-right">{formatCurrency(item.unit_price as number)}</td>
                            <td className="py-2 text-right">{formatCurrency(item.line_total as number)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Order Data */}
          {order && (
            <Card>
              <CardHeader>
                <h3 className="font-semibold text-slate-900">Order Data</h3>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                  <MetaRow label="Order #" value={order.order_number || '—'} />
                  <MetaRow label="Date" value={order.order_date || '—'} />
                  <MetaRow label="Customer" value={order.customer_name || '—'} />
                  <MetaRow label="Ship To" value={order.shipping_address || '—'} />
                  <MetaRow label="Total" value={formatCurrency(order.total_amount)} />
                  <MetaRow label="Delivery" value={order.delivery_date || '—'} />
                </div>

                {order.order_lines && order.order_lines.length > 0 && (
                  <div>
                    <h4 className="font-medium text-slate-700 mb-2">Line Items</h4>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-slate-500 border-b">
                          <th className="text-left py-2">#</th>
                          <th className="text-left py-2">Description</th>
                          <th className="text-left py-2">SKU</th>
                          <th className="text-right py-2">Qty</th>
                          <th className="text-right py-2">Price</th>
                          <th className="text-right py-2">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {order.order_lines.map((item: Record<string, unknown>) => (
                          <tr key={item.id as string}>
                            <td className="py-2">{item.line_number as number}</td>
                            <td className="py-2">{(item.description as string) || '—'}</td>
                            <td className="py-2">{(item.sku_code as string) || '—'}</td>
                            <td className="py-2 text-right">{item.quantity as number}</td>
                            <td className="py-2 text-right">{formatCurrency(item.unit_price as number)}</td>
                            <td className="py-2 text-right">{formatCurrency(item.line_total as number)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Validation Results */}
          {validationChecks && validationChecks.length > 0 && (
            <Card>
              <CardHeader>
                <h3 className="font-semibold text-slate-900">Validation Results</h3>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {validationChecks.map((v, idx) => (
                    <div
                      key={idx}
                      className={`flex items-center gap-3 p-2 rounded text-sm ${
                        v.passed ? 'bg-green-50' : 'bg-red-50'
                      }`}
                    >
                      <span className={`w-2 h-2 rounded-full ${v.passed ? 'bg-green-500' : 'bg-red-500'}`} />
                      <span className={v.passed ? 'text-green-800' : 'text-red-800'}>
                        {v.check_name}
                      </span>
                      {v.message && <span className="text-slate-500 ml-auto text-xs">{v.message}</span>}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* OCR Raw Text (from document directly) */}
          {doc.ocr_raw_text && (
            <Card>
              <CardHeader>
                <h3 className="font-semibold text-slate-900">OCR Extracted Text</h3>
              </CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap text-xs text-slate-700 bg-slate-50 p-4 rounded-lg max-h-64 overflow-y-auto">
                  {doc.ocr_raw_text || 'No text extracted'}
                </pre>
              </CardContent>
            </Card>
          )}

          {/* Processing Logs (from document JSONB) */}
          {processingLog && processingLog.length > 0 && (
            <Card>
              <CardHeader>
                <h3 className="font-semibold text-slate-900">Processing Log</h3>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {processingLog.map((log, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-xs">
                      <span className="text-slate-400 whitespace-nowrap">
                        {new Date(log.ts).toLocaleTimeString()}
                      </span>
                      <Badge className={
                        log.status === 'failed' ? 'bg-red-100 text-red-700' :
                        log.status === 'started' ? 'bg-yellow-100 text-yellow-700' :
                        'bg-green-100 text-green-700'
                      }>
                        {log.status}
                      </Badge>
                      <span className="text-slate-500">[{log.stage}]</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-900 font-medium">{value || '—'}</span>
    </div>
  );
}
