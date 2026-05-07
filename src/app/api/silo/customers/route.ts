import { NextResponse } from 'next/server';
import { fetchCustomers } from '@/lib/silo/client';

export async function GET() {
  try {
    const data = await fetchCustomers(500);
    return NextResponse.json(data);
  } catch (e) {
    console.error('Silo customers error:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to fetch customers' }, { status: 502 });
  }
}
