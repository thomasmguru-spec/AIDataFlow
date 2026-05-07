'use client';

import { useState, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui';
import { Upload } from 'lucide-react';
import toast from 'react-hot-toast';

export function DocumentUpload() {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    const supabase = createClient();

    try {
      for (const file of Array.from(files)) {
        const ext = file.name.split('.').pop();
        const fileName = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const filePath = `uploads/${new Date().toISOString().slice(0, 10)}/${fileName}`;

        // Upload to Supabase Storage
        const { error: uploadError } = await supabase.storage
          .from('original-documents')
          .upload(filePath, file);

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('original-documents')
          .getPublicUrl(filePath);

        // Create document record
        const { error: dbError } = await supabase.from('documents').insert({
          source: 'cloud_upload',
          original_filename: file.name,
          file_url: publicUrl,
          file_size_bytes: file.size,
          file_mime_type: file.type,
          status: 'new',
        } as any);

        if (dbError) throw dbError;
      }

      toast.success(`${files.length} document(s) uploaded successfully`);
      window.location.reload();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <Button
        variant="primary"
        disabled={uploading}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="w-4 h-4" />
        {uploading ? 'Uploading...' : 'Upload Documents'}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.jpg,.jpeg,.png,.heic"
        onChange={handleUpload}
        className="hidden"
      />
    </>
  );
}
