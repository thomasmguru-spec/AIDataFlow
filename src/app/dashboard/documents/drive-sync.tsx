'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';

export function DriveSyncButton() {
  const [syncing, setSyncing] = useState(false);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch('/api/gdrive/sync');
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Sync failed');
        return;
      }

      if (data.imported > 0) {
        toast.success(`Synced ${data.imported} new document(s) from Google Drive`);
        // Reload page to show new documents
        window.location.reload();
      } else {
        toast.success(`No new files to sync (${data.total_in_folder || 0} files in folder)`);
      }
    } catch (err) {
      toast.error('Failed to sync with Google Drive');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Button
      onClick={handleSync}
      disabled={syncing}
      className="flex items-center gap-2 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
    >
      <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
      {syncing ? 'Syncing...' : 'Sync Google Drive'}
    </Button>
  );
}
