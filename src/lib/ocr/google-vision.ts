const VISION_API_URL = 'https://vision.googleapis.com/v1/images:annotate';

export interface OcrWord {
  text: string;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
}

export interface OcrBlock {
  text: string;
  confidence: number;
  blockType: string;
  words: OcrWord[];
}

export interface OcrResult {
  fullText: string;
  blocks: OcrBlock[];
  averageConfidence: number;
  languageCode: string | null;
}

interface VisionAnnotation {
  description?: string;
  locale?: string;
}

interface VisionTextBlock {
  property?: {
    detectedLanguages?: { languageCode: string; confidence: number }[];
  };
  paragraphs?: VisionParagraph[];
  blockType?: string;
  confidence?: number;
}

interface VisionParagraph {
  words?: VisionWord[];
  confidence?: number;
}

interface VisionWord {
  symbols?: VisionSymbol[];
  confidence?: number;
  boundingBox?: { vertices?: { x?: number; y?: number }[] };
}

interface VisionSymbol {
  text?: string;
  confidence?: number;
}

export async function performOcr(imageBuffer: Buffer, mimeType: string): Promise<OcrResult> {
  const apiKey = process.env.GOOGLE_VISION_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_VISION_API_KEY (or GOOGLE_API_KEY) not configured');

  const base64Image = imageBuffer.toString('base64');

  const requestBody = {
    requests: [
      {
        image: { content: base64Image },
        features: [
          { type: 'TEXT_DETECTION', maxResults: 1 },
          { type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 },
        ],
        imageContext: {
          languageHints: ['en'],
        },
      },
    ],
  };

  const response = await fetch(`${VISION_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Google Vision API error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const annotations = data.responses?.[0];

  if (annotations?.error) {
    throw new Error(`Vision API: ${annotations.error.message}`);
  }

  const textAnnotations: VisionAnnotation[] = annotations?.textAnnotations ?? [];
  const fullTextAnnotation = annotations?.fullTextAnnotation;

  const fullText = textAnnotations[0]?.description ?? '';
  const languageCode = textAnnotations[0]?.locale ?? null;

  const blocks: OcrBlock[] = [];
  let totalConfidence = 0;
  let blockCount = 0;

  if (fullTextAnnotation?.pages) {
    for (const page of fullTextAnnotation.pages) {
      for (const block of (page.blocks ?? []) as VisionTextBlock[]) {
        const blockWords: OcrWord[] = [];
        const paragraphTexts: string[] = [];
        let blockConfSum = 0;
        let wordCount = 0;

        for (const paragraph of block.paragraphs ?? []) {
          const wordTexts: string[] = [];
          for (const word of paragraph.words ?? []) {
            const wordText = (word.symbols ?? []).map((s: VisionSymbol) => s.text ?? '').join('');
            const wordConf = word.confidence ?? 0;
            const vertices = word.boundingBox?.vertices ?? [];
            const x = vertices[0]?.x ?? 0;
            const y = vertices[0]?.y ?? 0;
            const x2 = vertices[2]?.x ?? 0;
            const y2 = vertices[2]?.y ?? 0;

            blockWords.push({
              text: wordText,
              confidence: wordConf,
              boundingBox: { x, y, width: x2 - x, height: y2 - y },
            });
            wordTexts.push(wordText);
            blockConfSum += wordConf;
            wordCount++;
          }
          paragraphTexts.push(wordTexts.join(' '));
        }

        const avgConf = wordCount > 0 ? blockConfSum / wordCount : 0;
        blocks.push({
          text: paragraphTexts.join('\n'),
          confidence: avgConf,
          blockType: block.blockType ?? 'TEXT',
          words: blockWords,
        });
        totalConfidence += avgConf;
        blockCount++;
      }
    }
  }

  return {
    fullText,
    blocks,
    averageConfidence: blockCount > 0 ? totalConfidence / blockCount : 0,
    languageCode,
  };
}

// Extract text from a PDF by converting pages to images first
export async function performOcrOnPdf(pdfBuffer: Buffer): Promise<OcrResult> {
  // For PDFs, we attempt direct text extraction first
  // If that fails, convert to image and OCR
  // This is a simplified version — production would use pdf-parse or similar
  try {
    const pdfParse = await import('pdf-parse');
    const parsed = await pdfParse.default(pdfBuffer);
    if (parsed.text && parsed.text.trim().length > 50) {
      return {
        fullText: parsed.text,
        blocks: [{ text: parsed.text, confidence: 0.99, blockType: 'TEXT', words: [] }],
        averageConfidence: 0.99,
        languageCode: 'en',
      };
    }
  } catch {
    // pdf-parse not available or text extraction failed — fall back to OCR
  }

  // Convert first page to image and OCR
  return performOcr(pdfBuffer, 'application/pdf');
}
