// ── Enum-like types (match DB CHECK constraints) ──
export type DocumentSource = 'email' | 'whatsapp' | 'scanner' | 'cloud_upload' | 'google_drive';
export type DocumentType = 'invoice' | 'order' | 'receipt' | 'unstructured' | 'unknown';
export type DocumentStatus =
  | 'new' | 'processing' | 'extracted' | 'validated'
  | 'exception' | 'approved' | 'ready_for_export' | 'exported' | 'failed';
export type ExceptionStatus = 'pending' | 'in_review' | 'approved' | 'rejected';
export type ExceptionPriority = 'low' | 'medium' | 'high' | 'critical';
// Canonical roles. Legacy values 'reviewer' & 'read_only' are kept for
// backward-compat with existing rows and treated as 'validator' / 'user'
// respectively by the permission helpers.
export type UserRole =
  | 'admin'
  | 'manager'
  | 'validator'
  | 'user'
  | 'reviewer'   // legacy alias of 'validator'
  | 'read_only'; // legacy alias of 'user'

export type InvoiceApprovalStatus = 'draft' | 'under_review' | 'approved' | 'rejected';
export type ValidationCheckType =
  | 'completeness' | 'sku_match' | 'customer_match' | 'vendor_match'
  | 'range_check' | 'date_check' | 'math_check' | 'total_check'
  | 'duplicate_check' | 'business_rule';
export type ValidationStatus = 'pending' | 'passed' | 'failed';
export type ExportStatus = 'pending' | 'exported' | 'confirmed' | 'failed';

// ── Validation check (stored in JSONB arrays on invoices/orders) ──
export interface ValidationCheck {
  check_type: ValidationCheckType;
  check_name: string;
  passed: boolean;
  severity: 'error' | 'warning' | 'info';
  message: string;
  field_name?: string;
  expected_value?: string;
  actual_value?: string;
}

// ── Processing log entry (stored in JSONB array on documents) ──
export interface ProcessingLogEntry {
  stage: string;
  status: 'started' | 'completed' | 'failed';
  ts: string;
  details?: Record<string, unknown>;
}

// ── Exception comment (stored in JSONB array on invoices/orders) ──
export interface ExceptionComment {
  user_id: string;
  user_name: string;
  comment: string;
  created_at: string;
}

// ── Table 1: Users ──
export interface User {
  id: string;
  auth_user_id: string | null;
  email: string | null;
  full_name: string;
  role: UserRole;
  is_active: boolean;
  preferences: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ── Table 2: Documents (wide) ──
export interface Document {
  id: string;
  source: DocumentSource;
  source_identifier: string | null;
  original_filename: string | null;
  file_url: string;
  file_size_bytes: number | null;
  file_mime_type: string | null;
  document_type: DocumentType;
  classification_confidence: number | null;
  status: DocumentStatus;
  // Source metadata
  email_subject: string | null;
  email_sender: string | null;
  whatsapp_sender: string | null;
  whatsapp_message_id: string | null;
  scan_dpi: number | null;
  // OCR (denormalized)
  ocr_raw_text: string | null;
  ocr_confidence: number | null;
  ocr_language: string | null;
  ocr_word_count: number | null;
  ocr_blocks: unknown | null;
  // Preprocessing (denormalized)
  preprocessed_file_url: string | null;
  preprocessing_ops: Record<string, boolean> | null;
  // Processing
  processing_log: ProcessingLogEntry[];
  total_processing_time_ms: number | null;
  error_message: string | null;
  retry_count: number;
  // Timestamps
  received_at: string;
  processed_at: string | null;
  exported_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Table 3: Invoices (wide) ──
export interface Invoice {
  id: string;
  document_id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  payment_terms: string | null;
  currency: string;
  // Vendor (denormalized)
  vendor_name: string | null;
  vendor_code: string | null;
  vendor_address: string | null;
  vendor_gstin: string | null;
  vendor_email: string | null;
  vendor_phone: string | null;
  // Bill-to
  bill_to_name: string | null;
  bill_to_address: string | null;
  // Amounts
  subtotal: number | null;
  tax_amount: number | null;
  discount_amount: number | null;
  total_amount: number | null;
  field_confidences: Record<string, number>;
  // Validation (denormalized)
  validation_status: ValidationStatus;
  validation_checks: ValidationCheck[];
  validation_errors: number;
  validation_warnings: number;
  // Exception (denormalized)
  exception_status: ExceptionStatus | null;
  exception_priority: ExceptionPriority | null;
  exception_reason: string | null;
  exception_assigned_to: string | null;
  exception_reviewed_by: string | null;
  exception_reviewed_at: string | null;
  exception_notes: string | null;
  exception_comments: ExceptionComment[];
  corrections_made: Record<string, unknown>;
  is_duplicate: boolean;
  // Export (denormalized)
  export_status: ExportStatus | null;
  export_batch_id: string | null;
  export_csv_url: string | null;
  exported_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Table 4: Invoice Lines (wide) ──
export interface InvoiceLine {
  id: string;
  invoice_id: string;
  line_number: number;
  description: string | null;
  sku_code: string | null;
  sku_name: string | null;
  hsn_code: string | null;
  unit_of_measure: string | null;
  quantity: number | null;
  unit_price: number | null;
  discount: number | null;
  tax_rate: number | null;
  tax_amount: number | null;
  line_total: number | null;
  sku_matched: boolean;
  math_valid: boolean | null;
  field_confidences: Record<string, number>;
  created_at: string;
}

// ── Table 5: Orders (wide) ──
export interface Order {
  id: string;
  document_id: string;
  order_number: string | null;
  order_date: string | null;
  delivery_date: string | null;
  payment_terms: string | null;
  special_instructions: string | null;
  currency: string;
  // Customer (denormalized)
  customer_name: string | null;
  customer_code: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  customer_whatsapp: string | null;
  billing_address: string | null;
  shipping_address: string | null;
  // Amounts
  subtotal: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  field_confidences: Record<string, number>;
  // Validation
  validation_status: ValidationStatus;
  validation_checks: ValidationCheck[];
  validation_errors: number;
  validation_warnings: number;
  // Exception
  exception_status: ExceptionStatus | null;
  exception_priority: ExceptionPriority | null;
  exception_reason: string | null;
  exception_assigned_to: string | null;
  exception_reviewed_by: string | null;
  exception_reviewed_at: string | null;
  exception_notes: string | null;
  exception_comments: ExceptionComment[];
  corrections_made: Record<string, unknown>;
  is_duplicate: boolean;
  requires_approval: boolean;
  // Export
  export_status: ExportStatus | null;
  export_batch_id: string | null;
  export_csv_url: string | null;
  exported_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Table 6: Order Lines (wide) ──
export interface OrderLine {
  id: string;
  order_id: string;
  line_number: number;
  description: string | null;
  sku_code: string | null;
  sku_name: string | null;
  unit_of_measure: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
  sku_matched: boolean;
  field_confidences: Record<string, number>;
  created_at: string;
}
