'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { CloudDownload, RefreshCw, Check, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';

interface ImportResult {
  imported: number;
  failed?: number;
  total_in_folder: number;
  new_documents?: { document_id: string; filename: string }[];
  errors?: { filename: string; error: string }[];
  message?: string;
}

export function GDriveImportButton() {
  const [importing, setImporting] = useState(false);
  const [lastResult, setLastResult] = useState<ImportResult | null>(null);

  async function handleImport() {
    setImporting(true);
    setLastResult(null);

    try {
      const res = await fetch('/api/gdrive/import', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Import failed');
        return;
      }

      setLastResult(data);

      if (data.imported > 0) {
        toast.success(`${data.imported} naye document(s) Google Drive se import ho gaye!`);
        // Reload after a short delay so user can see the toast
        setTimeout(() => window.location.reload(), 1500);
      } else {
        toast.success(data.message || 'Sab documents pehle se import hain');
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="primary"
        disabled={importing}
        onClick={handleImport}
      >
        {importing ? (
          <RefreshCw className="w-4 h-4 animate-spin" />
        ) : (
          <CloudDownload className="w-4 h-4" />
        )}
        {importing ? 'Importing...' : 'Google Drive Import'}
      </Button>

      {lastResult && (
        <span className="text-sm text-slate-600 flex items-center gap-1">
          {lastResult.imported > 0 ? (
            <>
              <Check className="w-4 h-4 text-green-600" />
              {lastResult.imported} imported
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4 text-amber-500" />
              {lastResult.message || 'No new files'}
            </>
          )}
          {lastResult.failed ? (
            <span className="text-red-500 ml-2">({lastResult.failed} failed)</span>
          ) : null}
        </span>
      )}
    </div>
  );
}
