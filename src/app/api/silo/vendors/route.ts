import { NextResponse } from 'next/server';
import { fetchVendors } from '@/lib/silo/client';

export async function GET() {
  try {
    const data = await fetchVendors(500);
    return NextResponse.json(data);
  } catch (e) {
    console.error('Silo vendors error:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to fetch vendors' }, { status: 502 });
  }
}
