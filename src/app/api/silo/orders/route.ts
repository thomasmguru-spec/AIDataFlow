import { NextRequest, NextResponse } from 'next/server';
import { fetchSalesOrders, fetchPurchaseOrders } from '@/lib/silo/client';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const type = searchParams.get('type') || 'sales'; // sales | purchase
  const first = Math.min(Number(searchParams.get('limit') || '500'), 500);
  const after = searchParams.get('after') || undefined;

  try {
    if (type === 'purchase') {
      const data = await fetchPurchaseOrders(first, after);
      return NextResponse.json(data.purchaseOrders);
    }

    const data = await fetchSalesOrders(first, after);
    return NextResponse.json(data.salesOrders);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Silo orders fetch error:', message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
