import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { validateRequest } from 'twilio';
import { processDocument } from '@/lib/processing/pipeline';
import { Twilio } from 'twilio';

// Vercel serverless: allow enough time for OCR + processing
export const maxDuration = 60;

// Send a WhatsApp reply via Twilio
async function sendWhatsAppReply(to: string, message: string) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_WHATSAPP_NUMBER;
  if (!accountSid || !authToken || !fromNumber) return;

  const client = new Twilio(accountSid, authToken);
  const fromWhatsApp = fromNumber.startsWith('whatsapp:') ? fromNumber : `whatsapp:${fromNumber}`;
  const toWhatsApp = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;

  await client.messages.create({
    from: fromWhatsApp,
    to: toWhatsApp,
    body: message,
  });
}

// Webhook endpoint for WhatsApp messages via Twilio
export async function POST(request: NextRequest) {
  try {
    // Twilio sends form-encoded by default
    const contentType = request.headers.get('content-type') || '';
    let body: Record<string, any>;
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await request.formData();
      body = Object.fromEntries(formData.entries());
    } else {
      body = await request.json();
    }

    // Verify Twilio webhook signature using Auth Token
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (authToken) {
      const twilioSignature = request.headers.get('x-twilio-signature');
      if (!twilioSignature) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const url = request.url;
      const isValid = validateRequest(authToken, twilioSignature, url, body);
      if (!isValid) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 403 });
      }
    }

    const supabase = createServiceRoleClient();

    // Twilio webhook payload format
    const waNumber = (body.From || body.WaId || '') as string;
    const senderName = (body.ProfileName || '') as string;
    const messageId = (body.MessageSid || body.SmsSid || '') as string;
    const numMedia = parseInt((body.NumMedia || '0') as string, 10);
    const textBody = (body.Body || '') as string;

    if (!waNumber) {
      return NextResponse.json({ error: 'Missing sender info' }, { status: 400 });
    }

    const cleanNumber = waNumber.replace(/[^\d]/g, '');
    const insertedDocIds: string[] = [];

    // Handle media messages — process ALL attachments, not just the first
    if (numMedia > 0) {
      const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
      const twilioAuth = process.env.TWILIO_AUTH_TOKEN || '';
      const fetchHeaders: Record<string, string> = {};
      if (accountSid && twilioAuth) {
        fetchHeaders['Authorization'] = `Basic ${Buffer.from(`${accountSid}:${twilioAuth}`).toString('base64')}`;
      }

      for (let i = 0; i < numMedia; i++) {
        const mediaUrl = (body[`MediaUrl${i}`] || '') as string;
        const mimeType = (body[`MediaContentType${i}`] || 'image/jpeg') as string;

        if (!mediaUrl) continue;

        const mediaRes = await fetch(mediaUrl, { headers: fetchHeaders });
        if (!mediaRes.ok) {
          console.error(`Twilio media ${i} download failed:`, mediaRes.status);
          continue;
        }

        const mediaBuffer = await mediaRes.arrayBuffer();
        const ext = mimeType.includes('pdf') ? 'pdf'
          : mimeType.includes('heic') || mimeType.includes('heif') ? 'heic'
          : mimeType.includes('png') ? 'png' : 'jpg';
        const storagePath = `whatsapp/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${i}.${ext}`;

        const { error: uploadError } = await supabase.storage
          .from('original-documents')
          .upload(storagePath, Buffer.from(mediaBuffer), { contentType: mimeType });

        if (uploadError) {
          console.error(`WhatsApp media ${i} upload failed:`, uploadError);
          continue;
        }

        const { data: doc } = await supabase.from('documents').insert({
          source: 'whatsapp',
          source_identifier: cleanNumber,
          original_filename: `WhatsApp_${messageId || Date.now()}_${i}`,
          file_url: storagePath,
          file_mime_type: mimeType,
          whatsapp_sender: cleanNumber,
          whatsapp_message_id: messageId,
          status: 'new',
        } as any).select('id').single();

        if (doc?.id) insertedDocIds.push(doc.id);
      }
    } else if (textBody) {
      // Text-only message — store as unstructured doc
      const textContent = new TextEncoder().encode(textBody);
      const storagePath = `whatsapp/${new Date().toISOString().slice(0, 10)}/${Date.now()}_text.txt`;

      await supabase.storage
        .from('original-documents')
        .upload(storagePath, textContent, { contentType: 'text/plain' });

      const { data: doc } = await supabase.from('documents').insert({
        source: 'whatsapp',
        source_identifier: cleanNumber,
        original_filename: `WhatsApp_Text_${Date.now()}`,
        file_url: storagePath,
        file_mime_type: 'text/plain',
        document_type: 'unstructured',
        whatsapp_sender: cleanNumber,
        whatsapp_message_id: messageId,
        status: 'new',
      } as any).select('id').single();

      if (doc?.id) insertedDocIds.push(doc.id);
    }

    // Auto-process all received documents through OCR + extraction pipeline
    const results: { id: string; status: string }[] = [];
    for (const docId of insertedDocIds) {
      try {
        await processDocument(docId);
        const { data: updated } = await supabase
          .from('documents')
          .select('id, status, document_type')
          .eq('id', docId)
          .single();
        results.push({ id: docId, status: updated?.status || 'processed' });
      } catch (procErr) {
        console.error(`Processing failed for doc ${docId}:`, procErr);
        results.push({ id: docId, status: 'processing_failed' });
      }
    }

    // Send WhatsApp confirmation back to sender
    if (insertedDocIds.length > 0) {
      const successCount = results.filter(r => r.status !== 'processing_failed').length;
      const failCount = results.length - successCount;
      let replyMsg = `✅ ${successCount} document(s) received and processed.`;
      if (failCount > 0) {
        replyMsg += ` ⚠️ ${failCount} failed — team will review.`;
      }
      if (senderName) {
        replyMsg = `Hi ${senderName}! ${replyMsg}`;
      }
      await sendWhatsAppReply(waNumber, replyMsg).catch(err =>
        console.error('Reply send failed:', err)
      );
    } else if (textBody) {
      await sendWhatsAppReply(
        waNumber,
        `📝 Text message received. Please send an image or PDF of your invoice/order for processing.`
      ).catch(err => console.error('Reply send failed:', err));
    }

    return NextResponse.json({
      status: 'received',
      messageId,
      documents: results,
    });
  } catch (err: unknown) {
    console.error('WhatsApp webhook error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
