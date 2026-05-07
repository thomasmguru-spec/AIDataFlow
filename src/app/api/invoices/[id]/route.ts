import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { requireCapability } from '@/lib/auth/permissions';

// Whitelist of editable invoice header fields.
const EDITABLE_INVOICE_FIELDS = new Set([
  'invoice_number',
  'invoice_date',
  'due_date',
  'payment_terms',
  'currency',
  'vendor_name',
  'vendor_address',
  'vendor_gstin',
  'vendor_email',
  'vendor_phone',
  'bill_to_name',
  'bill_to_address',
  'subtotal',
  'tax_amount',
  'discount_amount',
  'total_amount',
]);

interface LineEdit {
  id?: string;
  line_number?: number;
  description?: string | null;
  sku_code?: string | null;
  sku_name?: string | null;
  unit_of_measure?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
  discount?: number | null;
  tax_rate?: number | null;
  tax_amount?: number | null;
  line_total?: number | null;
  // Returns / adjustments
  returned_quantity?: number | null;
  credit_amount?: number | null;
  return_date?: string | null;
  return_reason?: string | null;
}

/**
 * PATCH /api/invoices/[id]
 * Body: { fields?: Partial<Invoice>, lines?: LineEdit[] }
 * Validator+ may edit. Manager+ may approve via the /approve route.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireCapability('invoices:edit');
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => ({}));
  const supabase = createServerSupabase();

  // Sanitize header field updates against whitelist.
  const cleanFields: Record<string, unknown> = {};
  if (body.fields && typeof body.fields === 'object') {
    for (const [k, v] of Object.entries(body.fields)) {
      if (EDITABLE_INVOICE_FIELDS.has(k)) cleanFields[k] = v;
    }
  }

  // Merge a "corrections_made" diff so the audit trail keeps a compact summary.
  if (Object.keys(cleanFields).length > 0) {
    const { error: updErr } = await supabase
      .from('invoices')
      .update({
        ...cleanFields,
        updated_at: new Date().toISOString(),
      } as never)
      .eq('id', params.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  // Apply line edits (insert / update / delete).
  if (Array.isArray(body.lines)) {
    for (const line of body.lines as LineEdit[]) {
      if (line.id) {
        // Update existing line
        const { error } = await supabase
          .from('invoice_lines')
          .update({
            description: line.description,
            sku_code: line.sku_code,
            sku_name: line.sku_name,
            quantity: line.quantity,
            unit_price: line.unit_price,
            discount: line.discount,
            tax_rate: line.tax_rate,
            tax_amount: line.tax_amount,
            line_total: line.line_total,
            returned_quantity: line.returned_quantity ?? undefined,
            credit_amount: line.credit_amount ?? undefined,
            return_date: line.return_date ?? undefined,
            return_reason: line.return_reason ?? undefined,
          } as never)
          .eq('id', line.id);
        if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      } else if (line.line_number != null) {
        // Insert new line
        const { error } = await supabase
          .from('invoice_lines')
          .insert({
            invoice_id: params.id,
            line_number: line.line_number,
            description: line.description ?? null,
            sku_code: line.sku_code ?? null,
            sku_name: line.sku_name ?? null,
            quantity: line.quantity ?? null,
            unit_price: line.unit_price ?? null,
            tax_amount: line.tax_amount ?? null,
            line_total: line.line_total ?? null,
          } as never);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
  }

  // Optional: explicit deletions of lines by id
  if (Array.isArray(body.delete_line_ids) && body.delete_line_ids.length > 0) {
    const { error } = await supabase
      .from('invoice_lines')
      .delete()
      .in('id', body.delete_line_ids as string[]);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Re-read for a fresh response (totals will have been recomputed by triggers)
  const { data, error } = await supabase
    .from('invoices')
    .select('*, invoice_lines(*)')
    .eq('id', params.id)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ status: 'ok', invoice: data, edited_by: auth.userId });
}

/** GET /api/invoices/[id] — fetch single invoice with lines (any viewer). */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireCapability('invoices:view');
  if (auth instanceof Response) return auth;

  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from('invoices')
    .select('*, invoice_lines(*), documents(*)')
    .eq('id', params.id)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json({ invoice: data });
}

/** DELETE /api/invoices/[id] — admin only. */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireCapability('invoices:delete');
  if (auth instanceof Response) return auth;

  const supabase = createServerSupabase();
  await supabase.from('invoice_lines').delete().eq('invoice_id', params.id);
  const { error } = await supabase.from('invoices').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ status: 'deleted', id: params.id, by: auth.userId });
}
