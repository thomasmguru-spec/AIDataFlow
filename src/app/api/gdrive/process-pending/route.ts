import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { ORDERS_FOLDER_ID } from '@/lib/gdrive/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/gdrive/process-pending?folder_kind=orders
 *
 * Returns the IDs of Google-Drive-imported documents that still need to run
 * through the OCR + LLM pipeline. Used by the "Sync Google Drive Orders"
 * button on /dashboard/orders to find docs imported by previous sync calls
 * (or by background cron) that never reached a successful state.
 *
 * A document is considered "pending" when:
 *   - status is one of new / processing / failed / exception, OR
 *   - status is 'extracted' but the orders row has zero order_lines (the
 *     LLM mapper produced nothing useful and the row is empty).
 *
 * The dashboard then POSTs /api/process for each returned id, throttled.
 */
export async function GET(req: NextRequest) {
  try {
    const supabase = createServiceRoleClient();
    const { searchParams } = req.nextUrl;
    const folderKindParam = searchParams.get('folder_kind');
    const limit = Math.min(Number(searchParams.get('limit') || '200'), 500);

    // Fetch GDrive documents that are NOT in a definitively-good final state.
    let q = supabase
      .from('documents')
      .select('id, status, gdrive_folder_kind, gdrive_folder_id, original_filename, created_at')
      .eq('source', 'google_drive' as any)
      .in('status', ['new', 'processing', 'failed', 'exception', 'extracted'] as any)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (folderKindParam) {
      // Tolerant match: kind column may be null because the DB CHECK
      // constraint historically did not allow 'orders' (see
      // isOrdersFolderDoc in lib/gdrive/client.ts). Fall back to
      // matching by folder_id when looking for orders docs.
      if (folderKindParam === 'orders') {
        q = q.or(`gdrive_folder_kind.eq.orders,gdrive_folder_id.eq.${ORDERS_FOLDER_ID}`);
      } else {
        q = q.eq('gdrive_folder_kind' as any, folderKindParam);
      }
    }

    const { data: docs, error } = await q;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // For 'extracted' rows, only keep them if the linked order has 0 lines
    // (i.e. the LLM mapper produced nothing). Other statuses are always
    // considered pending.
    const extractedIds = (docs || [])
      .filter((d: any) => d.status === 'extracted')
      .map((d: any) => d.id);

    const ordersWithLines = new Set<string>();
    if (extractedIds.length > 0) {
      const { data: orders } = await supabase
        .from('orders')
        .select('document_id, order_lines(id)')
        .in('document_id', extractedIds as any);
      for (const o of orders || []) {
        const lines = (o as any).order_lines;
        if (Array.isArray(lines) && lines.length > 0) {
          ordersWithLines.add((o as any).document_id);
        }
      }
    }

    const pending = (docs || []).filter((d: any) => {
      if (d.status === 'extracted') return !ordersWithLines.has(d.id);
      return true;
    });

    return NextResponse.json({
      total_candidates: (docs || []).length,
      pending: pending.length,
      document_ids: pending.map((d: any) => d.id),
      details: pending.map((d: any) => ({
        id: d.id,
        status: d.status,
        filename: d.original_filename,
      })),
    });
  } catch (err: unknown) {
    console.error('[gdrive/process-pending] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
