import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

// n8n calls this to POST scanner documents
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const scanDpi = formData.get('scan_dpi') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();
    const storagePath = `scanner/${new Date().toISOString().slice(0, 10)}/${Date.now()}.pdf`;

    const arrayBuffer = await file.arrayBuffer();
    const { error: uploadError } = await supabase.storage
      .from('original-documents')
      .upload(storagePath, Buffer.from(arrayBuffer), { contentType: file.type });

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data: { publicUrl } } = supabase.storage
      .from('original-documents')
      .getPublicUrl(storagePath);

    const { data: doc } = await supabase.from('documents').insert({
      source: 'scanner',
      original_filename: file.name,
      file_url: publicUrl,
      file_size_bytes: file.size,
      file_mime_type: file.type,
      scan_dpi: scanDpi ? parseInt(scanDpi) : 300,
      status: 'new',
    } as any).select('id').single();

    return NextResponse.json({ status: 'received', document_id: doc?.id });
  } catch (err: unknown) {
    console.error('Scanner webhook error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
