import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { drainAllProducts, type SiloItemMaster } from '@/lib/silo/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/item-master/sync
 *
 * Drains every product from Silo (walks BOTH purchaseOrders.orderItems and
 * salesOrders.orderItems with bisecting page sizes to skip past corrupt
 * legacy rows) and upserts the merged catalog into the item_master table.
 *
 * Critical: rows are upserted INCREMENTALLY as each Silo page arrives,
 * so even if the function gets killed by a Vercel timeout (10s on hobby,
 * 60s on Pro) the operator still ends up with hundreds of rows in the
 * table. The next sync just adds the rest.
 *
 * Body (optional): { pages?: number }   // safety cap on pages per source
 */
export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  let body: { pages?: number } = {};
  try {
    body = await req.json();
  } catch {
    /* allow empty body */
  }
  const maxPages = Math.min(Math.max(body.pages ?? 50, 1), 100);

  try {
    const supabase = createServiceRoleClient();
    const now = new Date().toISOString();
    let upserted = 0;
    let lastUpsertError: string | null = null;

    const upsertSlice = async (slice: SiloItemMaster[]) => {
      if (slice.length === 0) return;
      const rows = slice.map((it) => ({
        id: it.id,
        sku_code: it.sku_code,
        upc: it.upc,
        plu: it.plu,
        description: it.description,
        group_name: it.group,
        location: it.location,
        on_hand: it.quantity,
        unit_price: it.unitPrice,
        source: 'silo',
        last_synced_at: now,
      }));
      const { error } = await supabase
        .from('item_master')
        .upsert(rows as any, { onConflict: 'id' });
      if (error) {
        lastUpsertError = error.message;
      } else {
        upserted += slice.length;
      }
    };

    const { products, sources } = await drainAllProducts({
      maxPages,
      onPage: upsertSlice,
    });

    if (lastUpsertError && upserted === 0) {
      return NextResponse.json(
        { ok: false, error: lastUpsertError, sources, duration_ms: Date.now() - startedAt },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      upserted,
      unique_items: products.length,
      sources,
      last_upsert_error: lastUpsertError,
      duration_ms: Date.now() - startedAt,
      message: products.length === 0
        ? 'Silo returned no products from either purchase orders or sales orders.'
        : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Internal error',
        duration_ms: Date.now() - startedAt,
      },
      { status: 500 }
    );
  }
}

// Allow GET for convenience (browser-triggered sync from a button without a body).
export const GET = POST;
