'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Card, CardContent, CardHeader, Button, Input } from '@/components/ui';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';

interface Props {
  record: Record<string, unknown>;
  isInvoice: boolean;
  documentId: string;
}

export function ExceptionReviewForm({ record, isInvoice, documentId }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [comment, setComment] = useState('');
  const [resolutionNotes, setResolutionNotes] = useState('');

  const [fields, setFields] = useState(() => {
    if (isInvoice) {
      return {
        invoice_number: (record.invoice_number as string) || '',
        invoice_date: (record.invoice_date as string) || '',
        vendor_name: (record.vendor_name as string) || '',
        subtotal: String(record.subtotal ?? ''),
        tax_amount: String(record.tax_amount ?? ''),
        total_amount: String(record.total_amount ?? ''),
        payment_terms: (record.payment_terms as string) || '',
        due_date: (record.due_date as string) || '',
      };
    }
    return {
      order_number: (record.order_number as string) || '',
      order_date: (record.order_date as string) || '',
      customer_name: (record.customer_name as string) || '',
      shipping_address: (record.shipping_address as string) || '',
      total_amount: String(record.total_amount ?? ''),
      delivery_date: (record.delivery_date as string) || '',
      special_instructions: (record.special_instructions as string) || '',
    };
  });

  function updateField(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function handleAction(action: 'approve' | 'reject') {
    setLoading(true);
    const supabase = createClient();

    try {
      // Build corrections diff
      const corrections: Record<string, { old_value: string; new_value: string }> = {};
      for (const [key, val] of Object.entries(fields)) {
        const origVal = String((record as Record<string, unknown>)[key] ?? '');
        if (val !== origVal) {
          corrections[key] = { old_value: origVal, new_value: val };
        }
      }

      const table = isInvoice ? 'invoices' : 'orders';
      const { data: { user } } = await supabase.auth.getUser();

      // Build update data for the record
      const updateData: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(fields)) {
        if (['subtotal', 'tax_amount', 'total_amount'].includes(key)) {
          updateData[key] = val ? parseFloat(val) : null;
        } else {
          updateData[key] = val || null;
        }
      }

      // Update exception fields on the same record
      updateData.exception_status = action === 'approve' ? 'approved' : 'rejected';
      updateData.exception_reviewed_by = user?.id;
      updateData.exception_reviewed_at = new Date().toISOString();
      updateData.exception_notes = resolutionNotes || null;
      updateData.corrections_made = corrections;

      // Add comment to JSONB array if provided
      if (comment.trim()) {
        const existingComments = (record.exception_comments ?? []) as Array<Record<string, unknown>>;
        updateData.exception_comments = [
          ...existingComments,
          {
            user_id: user?.id,
            user_name: user?.email || 'User',
            comment: comment.trim(),
            created_at: new Date().toISOString(),
          },
        ];
      }

      await supabase
        .from(table)
        .update(updateData as any)
        .eq('id', record.id as string);

      // Update document status
      await supabase
        .from('documents')
        .update({
          status: action === 'approve' ? 'ready_for_export' : 'failed',
        } as any)
        .eq('id', documentId);

      toast.success(`Exception ${action === 'approve' ? 'approved' : 'rejected'} successfully`);
      router.push('/dashboard/exceptions');
      router.refresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setLoading(false);
    }
  }

  const isPending = record.exception_status === 'pending' || record.exception_status === 'in_review';

  return (
    <>
      <Card>
        <CardHeader>
          <h3 className="font-semibold text-slate-900">
            {isInvoice ? 'Invoice Data (Editable)' : 'Order Data (Editable)'}
          </h3>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            {Object.entries(fields).map(([key, value]) => (
              <Input
                key={key}
                id={key}
                label={key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                value={value}
                onChange={(e) => updateField(key, e.target.value)}
                disabled={!isPending}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {isPending && (
        <Card>
          <CardHeader>
            <h3 className="font-semibold text-slate-900">Review Decision</h3>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Resolution Notes
              </label>
              <textarea
                value={resolutionNotes}
                onChange={(e) => setResolutionNotes(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
                placeholder="Describe what was fixed or why rejected..."
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Add Comment (optional)
              </label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition text-sm"
                placeholder="Add a comment..."
              />
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                variant="primary"
                onClick={() => handleAction('approve')}
                disabled={loading}
                className="flex-1"
              >
                {loading ? 'Processing...' : 'Approve & Post to Silo'}
              </Button>
              <Button
                variant="danger"
                onClick={() => handleAction('reject')}
                disabled={loading}
              >
                Reject
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
