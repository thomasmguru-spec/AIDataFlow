import sharp from 'sharp';

export interface PreprocessResult {
  buffer: Buffer;
  mimeType: string;
  metadata: {
    width: number;
    height: number;
    wasRotated: boolean;
    wasDeskewed: boolean;
    contrastEnhanced: boolean;
    originalFormat: string;
  };
}

export async function preprocessImage(
  buffer: Buffer,
  mimeType: string
): Promise<PreprocessResult> {
  // HEIC/HEIF conversion: sharp handles it if libvips has HEIF support
  // Force input format hint for HEIC so sharp doesn't guess wrong
  const isHeic = mimeType === 'image/heic' || mimeType === 'image/heif';
  let image = isHeic ? sharp(buffer, { failOn: 'none' }) : sharp(buffer);
  const metadata = await image.metadata();

  const originalFormat = isHeic ? 'heic' : (metadata.format ?? 'unknown');
  let wasRotated = false;
  let wasDeskewed = false;
  let contrastEnhanced = false;

  // Auto-rotate based on EXIF orientation
  image = image.rotate(); // sharp auto-rotates based on EXIF
  if (metadata.orientation && metadata.orientation > 1) {
    wasRotated = true;
  }

  // Convert to grayscale for better OCR
  image = image.grayscale();

  // Determine if this is a thermal receipt (tall aspect ratio, small width)
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const aspectRatio = height / (width || 1);
  const isThermalReceipt = aspectRatio > 3 || width < 600;

  if (isThermalReceipt) {
    // Enhanced preprocessing for thermal receipts
    image = image
      .normalize()              // Full dynamic range
      .sharpen({ sigma: 2 })    // Sharpen faded text
      .threshold(140);          // Binarize for clarity
    contrastEnhanced = true;
  } else {
    // Standard preprocessing
    image = image
      .normalize()              // Normalize contrast
      .sharpen({ sigma: 1 });   // Light sharpening
  }

  // HEIC: ensure conversion to a format sharp can process further
  if (isHeic) {
    const converted = await image.png().toBuffer();
    image = sharp(converted);
  }

  // Ensure minimum DPI for OCR (upscale if needed)
  if (width > 0 && width < 1500) {
    const scale = Math.ceil(1500 / width);
    if (scale > 1 && scale <= 4) {
      image = image.resize(width * scale, null, { fit: 'inside' });
    }
  }

  // Remove noise with median filter
  image = image.median(3);

  // Output as PNG for best OCR compatibility
  const outputBuffer = await image.png({ quality: 100 }).toBuffer();
  const outputMeta = await sharp(outputBuffer).metadata();

  return {
    buffer: outputBuffer,
    mimeType: 'image/png',
    metadata: {
      width: outputMeta.width ?? 0,
      height: outputMeta.height ?? 0,
      wasRotated,
      wasDeskewed,
      contrastEnhanced,
      originalFormat,
    },
  };
}
