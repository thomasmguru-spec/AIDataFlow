import { NextRequest, NextResponse } from 'next/server';
import { fetchPayments } from '@/lib/silo/client';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const limit = Math.min(Number(searchParams.get('limit') || '500'), 500);
    const after = searchParams.get('after') || undefined;

    const data = await fetchPayments(limit, after);
    return NextResponse.json(data.payments);
  } catch (e) {
    console.error('Silo payments error:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to fetch payments' }, { status: 502 });
  }
}
