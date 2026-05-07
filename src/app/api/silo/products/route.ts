import { NextRequest, NextResponse } from 'next/server';
import { fetchProducts } from '@/lib/silo/client';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const limit = Math.min(Number(searchParams.get('limit') || '200'), 500);
    const after = searchParams.get('after') || undefined;

    const data = await fetchProducts(limit, after);
    return NextResponse.json(data);
  } catch (e) {
    console.error('Silo products error:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to fetch products' }, { status: 502 });
  }
}
