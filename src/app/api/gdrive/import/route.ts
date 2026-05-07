import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  listAllFolderFiles,
  downloadFile,
  getFolderIdForKind,
  type GDriveFolderKind,
} from '@/lib/gdrive/client';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '1YXNyUY14I_KRx2rNvu6gcNxtfboykjgY';

// Cap how many files one POST will download + insert. Each file involves a
// Drive download + storage upload, and Vercel serverless functions have a
// 60-second budget (export const maxDuration = 60). Processing too many at
// once exceeds the budget and Vercel returns an HTML 504 page that breaks
// `res.json()` on the client. The dashboard can be clicked again to ingest
// the next batch; OCR/LLM extraction is triggered separately by the
// background pipeline that picks up status='new' rows.
const DEFAULT_IMPORT_BATCH = 5;
const MAX_IMPORT_BATCH = 20;

/** POST: Import new files from Google Drive folder, download, upload to storage & run OCR */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const folderKind: GDriveFolderKind =
      body.folder_kind === 'vendor_invoices' ? 'vendor_invoices'
      : body.folder_kind === 'orders'        ? 'orders'
      : 'customer_invoices';
    const folderId = body.folder_id || (body.folder_kind ? getFolderIdForKind(folderKind) : FOLDER_ID);
    const batchSize = Math.min(
      Math.max(1, Number(body.batch_size) || DEFAULT_IMPORT_BATCH),
      MAX_IMPORT_BATCH
    );

    const supabase = createServiceRoleClient();

    // 1. List all files in Drive folder
    const driveFiles = await listAllFolderFiles(folderId);

    if (driveFiles.length === 0) {
      return NextResponse.json({ status: 'ok', imported: 0, message: 'No files found in Drive folder' });
    }

    // 2. Check which files are already imported (by gdrive_file_id stored in source_identifier)
    const { data: existingDocs } = await supabase
      .from('documents')
      .select('source_identifier')
      .eq('source', 'google_drive' as any)
      .not('source_identifier', 'is', null)
      .limit(10000);

    const alreadyImportedIds = new Set<string>();
    if (existingDocs) {
      for (const doc of existingDocs) {
        if (doc.source_identifier) {
          alreadyImportedIds.add(doc.source_identifier);
        }
      }
    }

    // 3. Filter to only new files, then cap to batch size.
    const allNewFiles = driveFiles.filter((f) => !alreadyImportedIds.has(f.id));
    const newFiles = allNewFiles.slice(0, batchSize);
    const remaining = Math.max(0, allNewFiles.length - newFiles.length);

    if (newFiles.length === 0) {
      return NextResponse.json({
        status: 'ok',
        imported: 0,
        total_in_folder: driveFiles.length,
        message: 'All files already imported',
      });
    }

    // 4. Download from GDrive, upload to Supabase storage, create doc & trigger OCR pipeline
    const imported: { document_id: string; filename: string }[] = [];
    const errors: { filename: string; error: string }[] = [];

    for (const file of newFiles) {
      try {
        // Download file content from Google Drive
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
          errors.push({ filename: file.name, error: `Upload: ${uploadError.message}` });
          continue;
        }

        // Create document record with storage path (not Drive URL).
        // The DB has a CHECK constraint on `gdrive_folder_kind` that only
        // accepts ('customer_invoices', 'vendor_invoices'). Migration
        // 20260429000001 widens it to also allow 'orders' but if that
        // migration hasn't been applied yet, the INSERT below would 23514
        // (check_violation) and silently drop the file. We guard against
        // that by retrying with `gdrive_folder_kind=null` — the orders
        // folder is still identifiable via `gdrive_folder_id`, and
        // isOrdersFolderDoc() in lib/gdrive/client.ts handles both cases.
        let { data: doc, error: dbError } = await supabase
          .from('documents')
          .insert({
            source: 'google_drive',
            source_identifier: file.id,
            original_filename: file.name,
            file_url: storagePath,
            file_size_bytes: file.size,
            file_mime_type: downloaded.mimeType,
            status: 'new',
            gdrive_folder_id: folderId,
            gdrive_folder_kind: folderKind,
          } as any)
          .select('id')
          .single();

        if (dbError && (dbError.code === '23514' || /check.*constraint/i.test(dbError.message))) {
          // Constraint rejected the new value — retry without folder_kind.
          const retry = await supabase
            .from('documents')
            .insert({
              source: 'google_drive',
              source_identifier: file.id,
              original_filename: file.name,
              file_url: storagePath,
              file_size_bytes: file.size,
              file_mime_type: downloaded.mimeType,
              status: 'new',
              gdrive_folder_id: folderId,
              // gdrive_folder_kind intentionally omitted — DB CHECK constraint
              // does not (yet) accept 'orders'. Detect via folder_id instead.
            } as any)
            .select('id')
            .single();
          doc = retry.data;
          dbError = retry.error;
        }

        if (dbError) {
          errors.push({ filename: file.name, error: dbError.message });
          continue;
        }

        imported.push({ document_id: doc!.id, filename: file.name });

        // NOTE: We intentionally do NOT trigger /api/process or processDocument
        // here. On Vercel serverless, work started after a response is sent is
        // killed when the function exits, and doing it inline blows the 60s
        // function budget for batches > ~3 files (causing the HTML 504 page
        // that breaks res.json() on the client). The OCR+LLM pipeline is
        // triggered separately (cron / GET /api/gdrive/sync companion / manual
        // POST /api/process for a specific document_id).
      } catch (err: unknown) {
        errors.push({
          filename: file.name,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return NextResponse.json({
      status: 'ok',
      imported: imported.length,
      failed: errors.length,
      total_in_folder: driveFiles.length,
      batch_size: batchSize,
      remaining_unimported: remaining,
      new_documents: imported,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: unknown) {
    console.error('Google Drive import error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}

/** GET: Check status — list files in Drive folder and show import status */
export async function GET() {
  try {
    const supabase = createServiceRoleClient();
    const driveFiles = await listAllFolderFiles(FOLDER_ID);

    // Get already imported file IDs
    const { data: existingDocs } = await supabase
      .from('documents')
      .select('source_identifier, status, created_at')
      .eq('source', 'google_drive' as any);

    const importedMap = new Map<string, { status: string; created_at: string }>();
    if (existingDocs) {
      for (const doc of existingDocs) {
        if (doc.source_identifier) {
          importedMap.set(doc.source_identifier, {
            status: doc.status as string,
            created_at: doc.created_at as string,
          });
        }
      }
    }

    const files = driveFiles.map((f) => ({
      ...f,
      imported: importedMap.has(f.id),
      import_status: importedMap.get(f.id) || null,
    }));

    const pendingCount = files.filter((f) => !f.imported).length;

    return NextResponse.json({
      folder_id: FOLDER_ID,
      total_files: files.length,
      imported: files.length - pendingCount,
      pending: pendingCount,
      files,
    });
  } catch (err: unknown) {
    console.error('Google Drive status error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
