import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

// Webhook endpoint for n8n email ingestion
// n8n downloads email attachments and POSTs them here
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const emailSender = formData.get('email_sender') as string | null;
    const emailSubject = formData.get('email_subject') as string | null;
    const filename = formData.get('filename') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();

    const ext = file.name.split('.').pop() || 'pdf';
    const storagePath = `email/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

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

    const { data: doc, error: dbError } = await supabase.from('documents').insert({
      source: 'email',
      source_identifier: emailSender || undefined,
      original_filename: filename || file.name,
      file_url: publicUrl,
      file_size_bytes: file.size,
      file_mime_type: file.type,
      email_sender: emailSender || undefined,
      email_subject: emailSubject || undefined,
      status: 'new',
    } as any).select('id').single();

    if (dbError) {
      return NextResponse.json({ error: dbError.message }, { status: 500 });
    }

    // Append ingestion log to documents.processing_log
    await supabase
      .from('documents')
      .update({
        processing_log: [{ stage: 'ingestion', status: 'completed', ts: new Date().toISOString(), details: { source: 'email', sender: emailSender, subject: emailSubject } }],
      } as any)
      .eq('id', doc.id);

    return NextResponse.json({ status: 'received', document_id: doc.id });
  } catch (err: unknown) {
    console.error('Email webhook error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
