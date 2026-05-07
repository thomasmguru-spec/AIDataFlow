import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      ...(init?.headers || {}),
    },
  });
}

/**
 * GET /api/item-master
 * Returns rows from the persistent item_master table (synced from Silo).
 * If the table is empty, the response includes a `_diag` block so we can
 * see which Supabase project the server-side client is actually pointing
 * at (production env-var mismatches were the historical failure mode).
 */
export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const projectRef = url.match(/^https?:\/\/([^.]+)\./)?.[1] || 'unknown';
  const hasServiceRole = !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  const serviceRoleHash = process.env.SUPABASE_SERVICE_ROLE_KEY
    ? process.env.SUPABASE_SERVICE_ROLE_KEY.slice(0, 8) + '…' + process.env.SUPABASE_SERVICE_ROLE_KEY.slice(-6)
    : null;

  try {
    const supabase = createServiceRoleClient();
    // Independent count via head:true so we know if the table itself is
    // empty vs the SELECT returning nothing because of a schema/RLS quirk.
    const headCount = await supabase
      .from('item_master')
      .select('*', { count: 'exact', head: true });

    const { data, error, count } = await supabase
      .from('item_master')
      .select('*', { count: 'exact' })
      .order('description', { ascending: true })
      .limit(2000);

    if (error) {
      return jsonNoStore(
        { error: error.message, _diag: { projectRef, hasServiceRole, serviceRoleHash, headCount: headCount.count, headError: headCount.error?.message } },
        { status: 500 }
      );
    }

    const items = data || [];
    return jsonNoStore({
      items,
      total: count ?? items.length,
      ...(items.length === 0 ? { _diag: { projectRef, hasServiceRole, serviceRoleHash, headCount: headCount.count, headError: headCount.error?.message } } : {}),
    });
  } catch (err) {
    return jsonNoStore(
      {
        error: err instanceof Error ? err.message : 'Internal error',
        _diag: { projectRef, hasServiceRole, serviceRoleHash },
      },
      { status: 500 }
    );
  }
}
