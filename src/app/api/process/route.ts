import { createServiceRoleClient } from '@/lib/supabase/server';
import { NextRequest, NextResponse } from 'next/server';
import { processDocument } from '@/lib/processing/pipeline';

// Vercel serverless: max duration 60s (Pro) or 10s (Hobby)
// We MUST await processing — fire-and-forget gets killed when response is sent
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { document_id } = body;

    if (!document_id) {
      return NextResponse.json({ error: 'document_id required' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();

    // Fetch document
    const { data: doc, error } = await supabase
      .from('documents')
      .select('*')
      .eq('id', document_id)
      .single();

    if (error || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Await processing — must complete before response is sent on Vercel
    await processDocument(document_id);

    // Re-fetch the document to return updated status
    const { data: updatedDoc } = await supabase
      .from('documents')
      .select('id, status, ocr_raw_text, ocr_confidence, document_type')
      .eq('id', document_id)
      .single();

    return NextResponse.json({
      status: 'completed',
      document_id,
      result: updatedDoc || { status: 'unknown' },
    });
  } catch (err: unknown) {
    console.error('Process API error:', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
