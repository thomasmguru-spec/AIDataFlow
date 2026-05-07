import type { DocumentType } from '@/types';

interface ClassificationResult {
  documentType: DocumentType;
  confidence: number;
  signals: string[];
}

const INVOICE_KEYWORDS = [
  'invoice', 'inv', 'bill', 'billing', 'accounts payable',
  'payment due', 'due date', 'tax invoice', 'remit to',
  'amount due', 'balance due', 'net amount', 'vat',
  'gst', 'total due', 'vendor', 'supplier',
];

const ORDER_KEYWORDS = [
  'order', 'purchase order', 'p.o.', 'po number', 'po#',
  'sales order', 'customer order', 'ship to', 'shipping',
  'delivery date', 'deliver to', 'ordered by', 'buyer',
  'quantity ordered', 'backorder',
];

const RECEIPT_KEYWORDS = [
  'receipt', 'cash register', 'change due', 'subtotal',
  'cashier', 'store', 'thank you', 'transaction',
  'payment received', 'paid', 'terminal',
];

function countKeywordMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw)).length;
}

export function classifyDocument(ocrText: string): ClassificationResult {
  const signals: string[] = [];

  const invoiceScore = countKeywordMatches(ocrText, INVOICE_KEYWORDS);
  const orderScore = countKeywordMatches(ocrText, ORDER_KEYWORDS);
  const receiptScore = countKeywordMatches(ocrText, RECEIPT_KEYWORDS);

  if (invoiceScore > 0) signals.push(`invoice_keywords=${invoiceScore}`);
  if (orderScore > 0) signals.push(`order_keywords=${orderScore}`);
  if (receiptScore > 0) signals.push(`receipt_keywords=${receiptScore}`);

  // Check for structural hints
  const hasLineItems = /\d+\s+[\d,.]+\s+[\d,.]+/m.test(ocrText);
  if (hasLineItems) signals.push('has_line_items');

  const hasInvoiceNumber = /inv(oice)?\s*[#:no.]*\s*\w+/i.test(ocrText);
  if (hasInvoiceNumber) signals.push('has_invoice_number');

  const hasOrderNumber = /(order|po)\s*[#:no.]*\s*\w+/i.test(ocrText);
  if (hasOrderNumber) signals.push('has_order_number');

  // Long aspect ratio text (many lines, short width) suggests receipt
  const lines = ocrText.split('\n').filter((l) => l.trim().length > 0);
  const avgLineLen = lines.reduce((sum, l) => sum + l.length, 0) / (lines.length || 1);
  const isReceiptFormat = lines.length > 20 && avgLineLen < 40;
  if (isReceiptFormat) signals.push('receipt_format');

  // Score decision
  const totalScore = invoiceScore + orderScore + receiptScore + (isReceiptFormat ? 3 : 0);

  if (totalScore === 0) {
    // Check if text is too short or looks handwritten (very low structure)
    if (ocrText.trim().length < 50) {
      return { documentType: 'unstructured', confidence: 0.3, signals: [...signals, 'very_short_text'] };
    }
    return { documentType: 'unknown', confidence: 0.2, signals: [...signals, 'no_keywords_found'] };
  }

  if (isReceiptFormat && receiptScore >= invoiceScore && receiptScore >= orderScore) {
    const confidence = Math.min(0.95, 0.5 + receiptScore * 0.1 + (isReceiptFormat ? 0.15 : 0));
    return { documentType: 'receipt', confidence, signals };
  }

  if (invoiceScore > orderScore) {
    const confidence = Math.min(0.95, 0.5 + invoiceScore * 0.08 + (hasInvoiceNumber ? 0.15 : 0));
    return { documentType: 'invoice', confidence, signals };
  }

  if (orderScore > invoiceScore) {
    const confidence = Math.min(0.95, 0.5 + orderScore * 0.08 + (hasOrderNumber ? 0.15 : 0));
    return { documentType: 'order', confidence, signals };
  }

  // Tie-break: default to invoice if both have keywords
  if (invoiceScore > 0 && invoiceScore === orderScore) {
    return { documentType: 'invoice', confidence: 0.4, signals: [...signals, 'tiebreak_invoice'] };
  }

  return { documentType: 'unknown', confidence: 0.2, signals };
}
