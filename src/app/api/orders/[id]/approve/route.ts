import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabase } from '@/lib/supabase/server';
import { requireCapability } from '@/lib/auth/permissions';

/**
 * POST /api/orders/[id]/approve
 * Body: { action: 'review' | 'approve' | 'reject', reason?: string }
 *
 * Status flow: draft → under_review → approved | rejected
 *   - 'review'  : validator+ moves draft → under_review
 *   - 'approve' : manager+   moves any   → approved
 *   - 'reject'  : manager+   moves any   → rejected (reason recommended)
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '').toLowerCase();
  const reason = body.reason ? String(body.reason) : null;

  const cap =
    action === 'approve' || action === 'reject'
      ? 'orders:approve'
      : action === 'review'
        ? 'orders:review'
        : null;

  if (!cap) {
    return NextResponse.json(
      { error: "Invalid action. Must be 'review', 'approve' or 'reject'." },
      { status: 400 }
    );
  }

  const auth = await requireCapability(cap);
  if (auth instanceof Response) return auth;

  const supabase = createServerSupabase();
  const now = new Date().toISOString();

  let patch: Record<string, unknown> = { updated_at: now };
  if (action === 'review') {
    patch = { ...patch, approval_status: 'under_review', reviewed_by: auth.userId, reviewed_at: now };
  } else if (action === 'approve') {
    patch = {
      ...patch,
      approval_status: 'approved',
      approved_by: auth.userId,
      approved_at: now,
      reviewed_by: auth.userId,
      reviewed_at: now,
      rejection_reason: null,
    };
  } else if (action === 'reject') {
    patch = {
      ...patch,
      approval_status: 'rejected',
      approved_by: auth.userId,
      approved_at: now,
      rejection_reason: reason,
    };
  }

  const { data, error } = await supabase
    .from('orders')
    .update(patch as never)
    .eq('id', params.id)
    .select('id, approval_status, reviewed_at, approved_at, rejection_reason')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ status: 'ok', order: data, action, by: auth.userId });
}
