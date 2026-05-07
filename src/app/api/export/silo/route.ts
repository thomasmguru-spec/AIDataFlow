import { NextRequest, NextResponse } from 'next/server';
import { generateSiloExport, type SiloExportOptions } from '@/lib/silo/exporter';

export async function POST(request: NextRequest) {
  try {
    let body: { mode?: SiloExportOptions['mode'] } = {};
    try { body = await request.json(); } catch { /* no body is fine */ }
    const mode = body.mode === 'test_approved' ? 'test_approved' : 'all';
    const result = await generateSiloExport({ mode });
    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error('Silo export error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Export failed' },
      { status: 500 }
    );
  }
}
