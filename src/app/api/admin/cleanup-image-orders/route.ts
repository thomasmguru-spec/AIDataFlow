import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

/**
 * POST /api/admin/cleanup-image-orders
 *
 * Deletes orders (and their order_lines) that were created from WhatsApp
 * image attachments.  These records were produced by the old pipeline
 * before robust OCR-quality and line-item validation was in place, and
 * may contain garbled / missing data.
 *
 * Identification criteria:
 *   orders.document_id → documents where
 *     source = 'whatsapp'  AND  file_mime_type LIKE 'image/%'
 *
 * Text-based orders (file_mime_type = 'text/plain') are NOT touched.
 * Orders from other sources (email, scanner, google_drive) are NOT touched.
 *
 * GET  – dry-run: returns the count and list of affected order IDs without deleting.
 * POST – performs the deletion.
 */

async function getImageOrderIds(supabase: ReturnType<typeof createServiceRoleClient>) {
  // Find document IDs that came from WhatsApp image attachments
  const { data: imageDocs, error: docErr } = await supabase
    .from('documents')
    .select('id')
    .eq('source', 'whatsapp')
    .like('file_mime_type', 'image/%');

  if (docErr) throw new Error(`Failed to query documents: ${docErr.message}`);
  if (!imageDocs || imageDocs.length === 0) return { docIds: [], orderIds: [] };

  const docIds = imageDocs.map((d) => d.id);

  // Find orders linked to those documents
  const { data: orders, error: ordErr } = await supabase
    .from('orders')
    .select('id, document_id')
    .in('document_id', docIds);

  if (ordErr) throw new Error(`Failed to query orders: ${ordErr.message}`);

  const orderIds = (orders || []).map((o) => o.id);
  return { docIds, orderIds };
}

/** GET – dry run */
export async function GET() {
  try {
    const supabase = createServiceRoleClient();
    const { docIds, orderIds } = await getImageOrderIds(supabase);

    return NextResponse.json({
      dryRun: true,
      imageDocumentCount: docIds.length,
      affectedOrderCount: orderIds.length,
      affectedOrderIds: orderIds,
    });
  } catch (err) {
    console.error('[cleanup-image-orders] GET error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}

/** POST – performs deletion */
export async function POST(req: NextRequest) {
  try {
    // Require explicit confirmation body to prevent accidental calls
    const body = await req.json().catch(() => ({}));
    if (body.confirm !== true) {
      return NextResponse.json(
        { error: 'Send { "confirm": true } in the request body to execute deletion.' },
        { status: 400 }
      );
    }

    const supabase = createServiceRoleClient();
    const { docIds, orderIds } = await getImageOrderIds(supabase);

    if (orderIds.length === 0) {
      return NextResponse.json({
        status: 'ok',
        message: 'No image-based orders found — nothing to delete.',
        deletedOrderCount: 0,
        deletedOrderLineCount: 0,
      });
    }

    // 1. Delete order_lines first (FK constraint)
    const { count: lineCount, error: lineErr } = await supabase
      .from('order_lines')
      .delete({ count: 'exact' })
      .in('order_id', orderIds);

    if (lineErr) throw new Error(`Failed to delete order_lines: ${lineErr.message}`);

    // 2. Delete the orders
    const { count: orderCount, error: orderErr } = await supabase
      .from('orders')
      .delete({ count: 'exact' })
      .in('id', orderIds);

    if (orderErr) throw new Error(`Failed to delete orders: ${orderErr.message}`);

    // 3. Reset the source documents back to 'failed' so they can be
    //    re-processed manually if needed, rather than sitting as orphans.
    await supabase
      .from('documents')
      .update({ status: 'failed', error_message: 'Cleaned up: image-based order had no valid extracted lines' } as any)
      .in('id', docIds)
      .eq('source', 'whatsapp');

    console.log(
      `[cleanup-image-orders] Deleted ${orderCount} orders, ${lineCount} order_lines from ${docIds.length} image documents.`
    );

    return NextResponse.json({
      status: 'ok',
      message: `Successfully removed ${orderCount} image-based order(s).`,
      deletedOrderCount: orderCount ?? 0,
      deletedOrderLineCount: lineCount ?? 0,
      affectedDocumentCount: docIds.length,
    });
  } catch (err) {
    console.error('[cleanup-image-orders] POST error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
