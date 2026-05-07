import { createServerSupabase } from '@/lib/supabase/server';
import { Card, CardContent, Badge } from '@/components/ui';
import { getStatusColor, formatDateTime } from '@/lib/utils';
import { FileText, Upload } from 'lucide-react';
import Link from 'next/link';
import { DocumentUpload } from './upload';

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: { page?: string; status?: string; source?: string; type?: string };
}) {
  const supabase = createServerSupabase();
  const page = parseInt(searchParams.page || '1');
  const perPage = 20;
  const offset = (page - 1) * perPage;

  let query = supabase
    .from('documents')
    .select('*', { count: 'exact' })
    .neq('source', 'google_drive' as any)
    .order('received_at', { ascending: false })
    .range(offset, offset + perPage - 1);

  if (searchParams.status) query = query.eq('status', searchParams.status);
  if (searchParams.source) query = query.eq('source', searchParams.source);
  if (searchParams.type) query = query.eq('document_type', searchParams.type);

  const { data: documents, count } = await query;
  const totalPages = Math.ceil((count || 0) / perPage);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Documents</h1>
          <p className="text-slate-500 mt-1">{count || 0} total documents</p>
        </div>
        <DocumentUpload />
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="py-3 space-y-2">
          {/* Status filters */}
          <div className="flex flex-wrap gap-2">
            <FilterLink href="/dashboard/documents" label="All" active={!searchParams.status && !searchParams.source} />
            <FilterLink href="/dashboard/documents?status=new" label="New" active={searchParams.status === 'new'} />
            <FilterLink href="/dashboard/documents?status=processing" label="Processing" active={searchParams.status === 'processing'} />
            <FilterLink href="/dashboard/documents?status=extracted" label="Extracted" active={searchParams.status === 'extracted'} />
            <FilterLink href="/dashboard/documents?status=validated" label="Validated" active={searchParams.status === 'validated'} />
            <FilterLink href="/dashboard/documents?status=exception" label="Exception" active={searchParams.status === 'exception'} />
            <FilterLink href="/dashboard/documents?status=exported" label="Exported" active={searchParams.status === 'exported'} />
            <FilterLink href="/dashboard/documents?status=failed" label="Failed" active={searchParams.status === 'failed'} />
          </div>
          {/* Source filters */}
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-2">
            <span className="text-xs text-slate-400 py-1">Source:</span>
            <FilterLink href="/dashboard/documents?source=whatsapp" label="📱 WhatsApp" active={searchParams.source === 'whatsapp'} />
            <FilterLink href="/dashboard/documents?source=email" label="📧 Email" active={searchParams.source === 'email'} />
            <FilterLink href="/dashboard/documents?source=scanner" label="🖨️ Scanner" active={searchParams.source === 'scanner'} />
            <FilterLink href="/dashboard/documents?source=cloud_upload" label="☁️ Upload" active={searchParams.source === 'cloud_upload'} />
          </div>
        </CardContent>
      </Card>

      {/* Documents Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-100">
                <th className="px-6 py-3 font-medium">Document</th>
                <th className="px-6 py-3 font-medium">Source</th>
                <th className="px-6 py-3 font-medium">Type</th>
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Confidence</th>
                <th className="px-6 py-3 font-medium">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {documents?.map((doc: { id: string; original_filename: string | null; source: string; document_type: string; status: string; ocr_confidence: number | null; received_at: string }) => (
                <tr key={doc.id} className="hover:bg-slate-50 transition">
                  <td className="px-6 py-3">
                    <Link href={`/dashboard/documents/${doc.id}`} className="flex items-center gap-2 text-brand-600 hover:underline font-medium">
                      <FileText className="w-4 h-4" />
                      {doc.original_filename || doc.id.slice(0, 12)}
                    </Link>
                  </td>
                  <td className="px-6 py-3 text-slate-600 capitalize">{doc.source.replace('_', ' ')}</td>
                  <td className="px-6 py-3 text-slate-600 capitalize">{doc.document_type}</td>
                  <td className="px-6 py-3">
                    <Badge className={getStatusColor(doc.status)}>{doc.status.replace('_', ' ')}</Badge>
                  </td>
                  <td className="px-6 py-3 text-slate-600">
                    {doc.ocr_confidence ? `${(doc.ocr_confidence * 100).toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-6 py-3 text-slate-500">{formatDateTime(doc.received_at)}</td>
                </tr>
              ))}
              {(!documents || documents.length === 0) && (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-500">
                    No documents found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
            <p className="text-sm text-slate-500">Page {page} of {totalPages}</p>
            <div className="flex gap-2">
              {page > 1 && (
                <Link
                  href={`/dashboard/documents?page=${page - 1}${searchParams.status ? `&status=${searchParams.status}` : ''}`}
                  className="px-3 py-1 rounded-lg border border-slate-300 text-sm hover:bg-slate-50"
                >
                  Previous
                </Link>
              )}
              {page < totalPages && (
                <Link
                  href={`/dashboard/documents?page=${page + 1}${searchParams.status ? `&status=${searchParams.status}` : ''}`}
                  className="px-3 py-1 rounded-lg border border-slate-300 text-sm hover:bg-slate-50"
                >
                  Next
                </Link>
              )}
            </div>
          </div>
        )}
      </Card>
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
