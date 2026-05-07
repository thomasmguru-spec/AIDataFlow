import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';

interface ServiceStatus {
  name: string;
  status: 'connected' | 'configured' | 'disconnected' | 'not_configured';
  detail?: string;
}

export async function GET() {
  const results: ServiceStatus[] = [];

  // 1. Supabase Database
  try {
    const supabase = createServiceRoleClient();
    const { count, error } = await supabase.from('users').select('*', { count: 'exact', head: true });
    if (error) throw error;
    results.push({ name: 'Supabase Database', status: 'connected', detail: `${count ?? 0} users` });
  } catch {
    results.push({ name: 'Supabase Database', status: 'disconnected', detail: 'Cannot reach database' });
  }

  // 2. Google Vision API
  const visionKey = process.env.GOOGLE_VISION_API_KEY;
  if (visionKey && visionKey !== 'your_google_vision_api_key') {
    results.push({ name: 'Google Vision API', status: 'configured', detail: 'API key set' });
  } else {
    results.push({ name: 'Google Vision API', status: 'not_configured', detail: 'GOOGLE_VISION_API_KEY missing' });
  }

  // 3. Supabase Storage
  try {
    const supabase = createServiceRoleClient();
    const { error } = await supabase.storage.listBuckets();
    if (error) throw error;
    results.push({ name: 'Supabase Storage', status: 'connected' });
  } catch {
    results.push({ name: 'Supabase Storage', status: 'disconnected', detail: 'Cannot access storage' });
  }

  // 4. n8n Workflow Engine
  const n8nUrl = process.env.N8N_WEBHOOK_URL;
  if (n8nUrl && n8nUrl !== 'https://your-n8n-instance.com/webhook/email-processor') {
    results.push({ name: 'n8n Workflow Engine', status: 'configured', detail: 'Webhook URL set' });
  } else {
    results.push({ name: 'n8n Workflow Engine', status: 'not_configured', detail: 'N8N_WEBHOOK_URL missing' });
  }

  // 5. Email (IMAP)
  const imapHost = process.env.IMAP_HOST;
  if (imapHost) {
    results.push({ name: 'Email (IMAP)', status: 'configured', detail: `Host: ${imapHost}` });
  } else {
    results.push({ name: 'Email (IMAP)', status: 'not_configured', detail: 'IMAP_HOST missing' });
  }

  // 6. WhatsApp (Twilio) — verify credentials by calling the API
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  if (twilioSid && twilioToken && twilioSid !== 'your_twilio_account_sid') {
    try {
      const twilioRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}.json`,
        {
          headers: {
            'Authorization': `Basic ${Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64')}`,
          },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (twilioRes.ok) {
        const info = await twilioRes.json();
        results.push({ name: 'WhatsApp (Twilio)', status: 'connected', detail: `Account: ${info.friendly_name || twilioSid}` });
      } else {
        results.push({ name: 'WhatsApp (Twilio)', status: 'disconnected', detail: `HTTP ${twilioRes.status} — check credentials` });
      }
    } catch {
      results.push({ name: 'WhatsApp (Twilio)', status: 'disconnected', detail: 'Cannot reach Twilio API' });
    }
  } else {
    results.push({ name: 'WhatsApp (Twilio)', status: 'not_configured', detail: 'Twilio credentials missing' });
  }

  // 7. Silo WMS
  try {
    const res = await fetch('https://app.usesilo.com/', { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    results.push({
      name: 'Silo WMS',
      status: res.ok || res.status === 301 || res.status === 302 ? 'connected' : 'disconnected',
      detail: `HTTP ${res.status}`,
    });
  } catch {
    results.push({ name: 'Silo WMS', status: 'disconnected', detail: 'Cannot reach Silo' });
  }

  // 8. Google Drive
  const gdriveKey = process.env.GOOGLE_API_KEY;
  const gdriveFolderId = process.env.GDRIVE_FOLDER_ID;
  if (gdriveKey && gdriveFolderId) {
    results.push({ name: 'Google Drive', status: 'configured', detail: `Folder: ${gdriveFolderId.slice(0, 8)}...` });
  } else {
    results.push({ name: 'Google Drive', status: 'not_configured', detail: 'GOOGLE_API_KEY or GDRIVE_FOLDER_ID missing' });
  }

  return NextResponse.json(results);
}
