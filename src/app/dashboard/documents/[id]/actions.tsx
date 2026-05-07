'use client';

import { Button } from '@/components/ui';
import { createClient } from '@/lib/supabase/client';
import { RotateCcw, Play } from 'lucide-react';
import toast from 'react-hot-toast';

export function DocumentActions({ documentId, currentStatus }: { documentId: string; currentStatus: string }) {
  async function handleReprocess() {
    const supabase = createClient();
    const { error } = await supabase
      .from('documents')
      .update({ status: 'new', error_message: null, retry_count: 0 } as any)
      .eq('id', documentId);

    if (error) {
      toast.error(error.message);
      return;
    }

    // Trigger n8n processing webhook
    try {
      await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: documentId }),
      });
    } catch {
      // Non-critical — n8n will pick it up on schedule
    }

    toast.success('Document queued for reprocessing');
    window.location.reload();
  }

  const canReprocess = ['failed', 'exception', 'rejected'].includes(currentStatus);

  return (
    <div className="flex gap-2">
      {canReprocess && (
        <Button variant="secondary" size="sm" onClick={handleReprocess}>
          <RotateCcw className="w-4 h-4" />
          Reprocess
        </Button>
      )}
      {currentStatus === 'new' && (
        <Button variant="primary" size="sm" onClick={handleReprocess}>
          <Play className="w-4 h-4" />
          Process Now
        </Button>
      )}
    </div>
  );
}
