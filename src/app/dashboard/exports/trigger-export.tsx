'use client';

import { Button } from '@/components/ui';
import { Upload } from 'lucide-react';
import { useState } from 'react';
import toast from 'react-hot-toast';

export function TriggerExportButton() {
  const [loading, setLoading] = useState(false);

  async function handleExport() {
    setLoading(true);
    try {
      const res = await fetch('/api/export/silo', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Export failed');
      toast.success(`Export created: ${data.invoiceCount || 0} invoices, ${data.orderCount || 0} orders`);
      window.location.reload();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={handleExport} disabled={loading}>
      <Upload className="w-4 h-4" />
      {loading ? 'Exporting...' : 'Export Now'}
    </Button>
  );
}
