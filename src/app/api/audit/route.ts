import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const supabase = createServiceRoleClient();
    const { searchParams } = req.nextUrl;

    const table = searchParams.get('table') || undefined;
    const action = searchParams.get('action') || undefined;
    const limit = Math.min(Number(searchParams.get('limit') || '100'), 500);
    const offset = Number(searchParams.get('offset') || '0');

    let query = (supabase as any)
      .from('audit_log')
      .select('*', { count: 'exact' })
      .order('performed_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (table) query = query.eq('table_name', table);
    if (action) query = query.eq('action', action);

    const { data, count, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data, total: count ?? 0 });
  } catch (err) {
    console.error('Audit log API error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
