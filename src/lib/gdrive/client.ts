import { google, drive_v3 } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// Default Google Drive folder ID from env or hardcoded fallback (customer invoices)
const DEFAULT_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '1YXNyUY14I_KRx2rNvu6gcNxtfboykjgY';

// Vendor invoices folder (separate Drive folder)
export const VENDOR_INVOICES_FOLDER_ID =
  process.env.GDRIVE_VENDOR_INVOICES_FOLDER_ID || '1ZdnaFXOk1LYC6_HaKnG_nHmDfiHO8b8Y';

// Customer purchase orders folder (shown on /dashboard/orders → New Orders → Google Drive).
export const ORDERS_FOLDER_ID =
  process.env.GDRIVE_ORDERS_FOLDER_ID || '1j6JMz8o50nmln2mW1zbOd-5PYR_kxP-K';

export type GDriveFolderKind = 'customer_invoices' | 'vendor_invoices' | 'orders';

export function getFolderIdForKind(kind: GDriveFolderKind): string {
  switch (kind) {
    case 'vendor_invoices': return VENDOR_INVOICES_FOLDER_ID;
    case 'orders':          return ORDERS_FOLDER_ID;
    case 'customer_invoices':
    default:                return DEFAULT_FOLDER_ID;
  }
}

/**
 * Identify whether a `documents` row came from the customer-orders Google
 * Drive folder. We need a tolerant check because the
 * `documents_gdrive_folder_kind_check` CHECK constraint did not historically
 * include `'orders'` — older rows store `gdrive_folder_kind=null` (or were
 * imported under `customer_invoices`) but their `gdrive_folder_id` matches
 * the orders folder. Once migration 20260429000001 is applied to the DB
 * the `gdrive_folder_kind` value will populate, but until then we rely on
 * the folder ID as the source of truth.
 */
export function isOrdersFolderDoc(doc: { gdrive_folder_kind?: string | null; gdrive_folder_id?: string | null } | null | undefined): boolean {
  if (!doc) return false;
  if (doc.gdrive_folder_kind === 'orders') return true;
  if (doc.gdrive_folder_id && doc.gdrive_folder_id === ORDERS_FOLDER_ID) return true;
  return false;
}

function getDriveClient(): drive_v3.Drive {
  // Option 1: Service Account JSON from env var
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (credentials) {
    const parsed = JSON.parse(credentials);
    const auth = new google.auth.GoogleAuth({ credentials: parsed, scopes: SCOPES });
    return google.drive({ version: 'v3', auth });
  }

  // Option 2: Service Account key file path
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile && keyFile !== 'path_to_service_account_json') {
    const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
    return google.drive({ version: 'v3', auth });
  }

  // Option 3: API key for public folder access
  const apiKey = process.env.GOOGLE_API_KEY;
  if (apiKey) {
    return google.drive({ version: 'v3', auth: apiKey });
  }

  throw new Error(
    'Google Drive credentials not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS, or GOOGLE_API_KEY env var.'
  );
}

export interface GDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdTime: string;
  modifiedTime: string;
  thumbnailLink?: string;
}

/** List image/PDF files from Google Drive folder */
export async function listFolderFiles(
  folderId: string = DEFAULT_FOLDER_ID,
  pageToken?: string
): Promise<{ files: GDriveFile[]; nextPageToken?: string }> {
  const drive = getDriveClient();

  const mimeTypes = [
    'image/jpeg',
    'image/png',
    'image/heic',
    'image/tiff',
    'application/pdf',
  ];

  const mimeQuery = mimeTypes.map((m) => `mimeType='${m}'`).join(' or ');

  const res = await drive.files.list({
    q: `'${folderId}' in parents and (${mimeQuery}) and trashed=false`,
    fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, thumbnailLink)',
    orderBy: 'createdTime desc',
    pageSize: 100,
    pageToken,
  });

  const files: GDriveFile[] = (res.data.files || []).map((f: any) => ({
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    size: parseInt(f.size || '0', 10),
    createdTime: f.createdTime!,
    modifiedTime: f.modifiedTime!,
    thumbnailLink: f.thumbnailLink || undefined,
  }));

  return { files, nextPageToken: res.data.nextPageToken || undefined };
}

/**
 * True when only an API key is configured (no service-account credentials).
 * The Google Drive API rejects `files.get?alt=media` with API-key auth,
 * even for publicly-shared files (returns HTML "Sorry, you can't view or
 * download this file at this time" with HTTP 403). In that case we fall
 * back to the public `uc?export=download` URL which works for files
 * shared as "Anyone with the link".
 */
function isApiKeyOnly(): boolean {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return false;
  if (
    process.env.GOOGLE_APPLICATION_CREDENTIALS &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS !== 'path_to_service_account_json'
  ) return false;
  return !!process.env.GOOGLE_API_KEY;
}

/** Download a public Drive file via the unauthenticated `uc?export=download` endpoint. */
async function downloadPublicFile(
  fileId: string,
  mimeType: string,
  name: string
): Promise<{ buffer: Buffer; mimeType: string; name: string }> {
  const baseUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  let res = await fetch(baseUrl, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Drive public download failed: ${res.status} ${res.statusText}`);
  }
  const ct = res.headers.get('content-type') || '';
  // For files >~25MB Google returns an HTML interstitial asking the user to
  // confirm the download (virus-scan warning). Parse the confirm token and
  // retry. Smaller files stream directly.
  if (ct.includes('text/html')) {
    const html = await res.text();
    const m =
      html.match(/confirm=([0-9A-Za-z_-]+)/) ||
      html.match(/name="confirm"\s+value="([^"]+)"/);
    const token = m?.[1];
    if (!token) {
      throw new Error(
        'Drive download blocked — make sure the file is shared as "Anyone with the link".'
      );
    }
    res = await fetch(
      `https://drive.google.com/uc?export=download&confirm=${token}&id=${fileId}`,
      { redirect: 'follow' }
    );
    if (!res.ok) {
      throw new Error(
        `Drive public download (confirm) failed: ${res.status} ${res.statusText}`
      );
    }
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType, name };
}

/** Download a file from Google Drive by its file ID */
export async function downloadFile(fileId: string): Promise<{ buffer: Buffer; mimeType: string; name: string }> {
  const drive = getDriveClient();

  // Get file metadata first (works with API key for public files)
  const meta = await drive.files.get({ fileId, fields: 'name, mimeType, size' });
  const mimeType = meta.data.mimeType || 'application/octet-stream';
  const name = meta.data.name || `gdrive_${fileId}`;

  // API key auth cannot download file content — use the public download URL.
  if (isApiKeyOnly()) {
    return downloadPublicFile(fileId, mimeType, name);
  }

  // Service account / OAuth — use the authenticated API.
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );

  return {
    buffer: Buffer.from(res.data as ArrayBuffer),
    mimeType,
    name,
  };
}

/** List ALL files (handles pagination) */
export async function listAllFolderFiles(folderId: string = DEFAULT_FOLDER_ID): Promise<GDriveFile[]> {
  const allFiles: GDriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const result = await listFolderFiles(folderId, pageToken);
    allFiles.push(...result.files);
    pageToken = result.nextPageToken;
  } while (pageToken);

  return allFiles;
}
