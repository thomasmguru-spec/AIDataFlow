import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  listAllFolderFiles,
  downloadFile,
  getFolderIdForKind,
  type GDriveFolderKind,
} from '@/lib/gdrive/client';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const SYNC_SECRET = process.env.GDRIVE_SYNC_SECRET;

/**
 * GET: Auto-sync endpoint — can be called by cron (e.g. n8n, Vercel Cron, etc.)
 * Lists files from public Google Drive folder and stores metadata in documents table.
 * Optionally protected by a secret token.
 */
export async function GET(request: Request) {
  // Verify secret if configured
  if (SYNC_SECRET) {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (token !== SYNC_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const supabase = createAdminClient();

    // Pick folder based on ?kind=vendor_invoices|customer_invoices (default customer)
    const url = new URL(request.url);
    const kindParam = (url.searchParams.get('kind') || 'customer_invoices') as GDriveFolderKind;
    const folderKind: GDriveFolderKind =
      kindParam === 'vendor_invoices' ? 'vendor_invoices'
      : kindParam === 'orders'        ? 'orders'
      : 'customer_invoices';
    const FOLDER_ID = getFolderIdForKind(folderKind);

    // List files in Drive
    const driveFiles = await listAllFolderFiles(FOLDER_ID);

    if (driveFiles.length === 0) {
      return NextResponse.json({ status: 'ok', imported: 0, total_in_folder: 0 });
    }

    // Get already imported IDs (fetch all, max 1000 default)
    const { data: existingDocs, error: selectError } = await supabase
      .from('documents')
      .select('source_identifier')
      .eq('source', 'google_drive' as any)
      .not('source_identifier', 'is', null)
      .limit(10000);

    if (selectError) {
      console.error('Sync: failed to fetch existing docs:', selectError.message);
    }

    const alreadyImportedIds = new Set<string>();
    if (existingDocs) {
      for (const doc of existingDocs) {
        if (doc.source_identifier) {
          alreadyImportedIds.add(doc.source_identifier);
        }
      }
    }

    const newFiles = driveFiles.filter((f) => !alreadyImportedIds.has(f.id));

    if (newFiles.length === 0) {
      return NextResponse.json({
        status: 'ok',
        imported: 0,
        total_in_folder: driveFiles.length,
        message: 'No new files',
      });
    }

    let imported = 0;
    let failed = 0;
    const errors: { filename: string; error: string }[] = [];

    for (const file of newFiles) {
      try {
        // Download file from Google Drive
        const downloaded = await downloadFile(file.id);

        // Upload to Supabase storage
        const ext = file.name.split('.').pop() || 'jpg';
        const storagePath = `gdrive/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${file.id}.${ext}`;

        const { error: uploadError } = await supabase.storage
          .from('original-documents')
          .upload(storagePath, downloaded.buffer, {
            contentType: downloaded.mimeType,
            upsert: true,
          });

        if (uploadError) {
          console.error(`Sync: upload error for ${file.name}:`, uploadError.message);
          failed++;
          errors.push({ filename: file.name, error: `Upload: ${uploadError.message}` });
          continue;
        }

        // Create document record with storage path. Same constraint-resilient
        // retry as in /api/gdrive/import — if the DB CHECK constraint hasn't
        // been migrated to allow 'orders', drop the kind and rely on
        // gdrive_folder_id (see isOrdersFolderDoc()).
        let { data: doc, error: dbError } = await supabase.from('documents').insert({
          source: 'google_drive',
          source_identifier: file.id,
          original_filename: file.name,
          file_url: storagePath,
          file_size_bytes: file.size,
          file_mime_type: downloaded.mimeType,
          status: 'new',
          gdrive_folder_id: FOLDER_ID,
          gdrive_folder_kind: folderKind,
        } as any).select('id').single();

        if (dbError && (dbError.code === '23514' || /check.*constraint/i.test(dbError.message))) {
          const retry = await supabase.from('documents').insert({
            source: 'google_drive',
            source_identifier: file.id,
            original_filename: file.name,
            file_url: storagePath,
            file_size_bytes: file.size,
            file_mime_type: downloaded.mimeType,
            status: 'new',
            gdrive_folder_id: FOLDER_ID,
          } as any).select('id').single();
          doc = retry.data;
          dbError = retry.error;
        }

        if (!dbError && doc) {
          imported++;
        } else if (dbError) {
          console.error(`Sync: db error for ${file.name}:`, dbError.message);
          failed++;
          errors.push({ filename: file.name, error: `DB: ${dbError.message}` });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Sync: error importing ${file.name}:`, msg);
        failed++;
        errors.push({ filename: file.name, error: msg });
      }
    }

    return NextResponse.json({
      status: 'ok',
      imported,
      failed,
      total_in_folder: driveFiles.length,
      new_found: newFiles.length,
      folder_kind: folderKind,
      folder_id: FOLDER_ID,
      errors: errors.slice(0, 10),
    });
  } catch (err: unknown) {
    console.error('Google Drive sync error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
