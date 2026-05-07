import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { requireCapability } from '@/lib/auth/permissions';

const EDITABLE_ORDER_FIELDS = new Set([
  'order_number',
  'order_date',
  'delivery_date',
  'customer_name',
  'customer_phone',
  'customer_email',
  'customer_whatsapp',
  'billing_address',
  'shipping_address',
  'subtotal',
  'tax_amount',
  'total_amount',
  'notes',
]);

interface LineEdit {
  id?: string;
  line_number?: number;
  description?: string | null;
  sku_code?: string | null;
  sku_name?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
  line_total?: number | null;
}

/** PATCH /api/orders/[id] — header + line edits (validator+). */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireCapability('orders:edit');
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => ({}));
  const supabase = createServerSupabase();

  const cleanFields: Record<string, unknown> = {};
  if (body.fields && typeof body.fields === 'object') {
    for (const [k, v] of Object.entries(body.fields)) {
      if (EDITABLE_ORDER_FIELDS.has(k)) cleanFields[k] = v;
    }
  }

  if (Object.keys(cleanFields).length > 0) {
    const { error: updErr } = await supabase
      .from('orders')
      .update({ ...cleanFields, updated_at: new Date().toISOString() } as never)
      .eq('id', params.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  }

  if (Array.isArray(body.lines)) {
    for (const line of body.lines as LineEdit[]) {
      if (line.id) {
        const { error } = await supabase
          .from('order_lines')
          .update({
            description: line.description,
            sku_code: line.sku_code,
            sku_name: line.sku_name,
            quantity: line.quantity,
            unit_price: line.unit_price,
            line_total: line.line_total,
          } as never)
          .eq('id', line.id);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      } else if (line.line_number != null) {
        const { error } = await supabase
          .from('order_lines')
          .insert({
            order_id: params.id,
            line_number: line.line_number,
            description: line.description ?? null,
            sku_code: line.sku_code ?? null,
            sku_name: line.sku_name ?? null,
            quantity: line.quantity ?? null,
            unit_price: line.unit_price ?? null,
            line_total: line.line_total ?? null,
          } as never);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
  }

  if (Array.isArray(body.delete_line_ids) && body.delete_line_ids.length > 0) {
    const { error } = await supabase
      .from('order_lines')
      .delete()
      .in('id', body.delete_line_ids as string[]);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data, error } = await supabase
    .from('orders')
    .select('*, order_lines(*)')
    .eq('id', params.id)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ status: 'ok', order: data, edited_by: auth.userId });
}

/** GET /api/orders/[id] — fetch single order with lines. */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireCapability('orders:view');
  if (auth instanceof Response) return auth;

  const supabase = createServerSupabase();
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_lines(*), documents(*)')
    .eq('id', params.id)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json({ order: data });
}

/** DELETE /api/orders/[id] — admin only. */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireCapability('orders:delete');
  if (auth instanceof Response) return auth;

  const supabase = createServerSupabase();
  await supabase.from('order_lines').delete().eq('order_id', params.id);
  const { error } = await supabase.from('orders').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ status: 'deleted', id: params.id, by: auth.userId });
}
