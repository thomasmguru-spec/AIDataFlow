-- ============================================================
-- Supabase Migration: Automated Invoice & Order Processing System
-- Version: 1.0
-- Date: 2026-04-06
-- Based on: SRS_Document_Invoice_Order_Processing_System.md
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for fuzzy text matching

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE document_source AS ENUM ('email', 'whatsapp', 'scanner', 'cloud_upload');
CREATE TYPE document_type AS ENUM ('invoice', 'order', 'receipt', 'unstructured', 'unknown');
CREATE TYPE document_status AS ENUM (
  'new',
  'preprocessing',
  'extracted',
  'parsed',
  'validating',
  'valid',
  'exception',
  'in_review',
  'approved',
  'rejected',
  'ready_for_silo',
  'exported',
  'completed',
  'archived',
  'failed'
);
CREATE TYPE exception_status AS ENUM ('pending', 'in_review', 'approved', 'rejected');
CREATE TYPE exception_priority AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE user_role AS ENUM ('admin', 'reviewer', 'read_only');
CREATE TYPE validation_check_type AS ENUM (
  'completeness',
  'sku_match',
  'customer_match',
  'vendor_match',
  'range_check',
  'date_check',
  'math_check',
  'total_check',
  'duplicate_check',
  'business_rule'
);
CREATE TYPE export_status AS ENUM ('pending', 'generating', 'uploaded', 'imported', 'confirmed', 'failed');

-- ============================================================
-- USER PROFILES (extends Supabase Auth)
-- ============================================================

CREATE TABLE user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'read_only',
  email TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- MASTER DATA TABLES
-- ============================================================

-- SKU / Item Master
CREATE TABLE master_skus (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  unit_price NUMERIC(12, 2),
  unit_of_measure TEXT,
  category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  silo_item_code TEXT,  -- mapped code in Silo WMS
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_master_skus_item_code ON master_skus(item_code);
CREATE INDEX idx_master_skus_description_trgm ON master_skus USING gin(description gin_trgm_ops);

-- Customer Master
CREATE TABLE master_customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_code TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  phone TEXT,
  whatsapp_number TEXT,  -- for WhatsApp sender mapping
  email TEXT,
  billing_address TEXT,
  shipping_address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  silo_customer_id TEXT,  -- mapped ID in Silo WMS
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_master_customers_code ON master_customers(customer_code);
CREATE INDEX idx_master_customers_name_trgm ON master_customers USING gin(customer_name gin_trgm_ops);
CREATE INDEX idx_master_customers_whatsapp ON master_customers(whatsapp_number);

-- Vendor Master
CREATE TABLE master_vendors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_code TEXT NOT NULL UNIQUE,
  vendor_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  silo_vendor_id TEXT,  -- mapped ID in Silo WMS
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_master_vendors_code ON master_vendors(vendor_code);
CREATE INDEX idx_master_vendors_name_trgm ON master_vendors USING gin(vendor_name gin_trgm_ops);

-- Vendor Templates (for template matching - SRS 4.2.4)
CREATE TABLE vendor_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id UUID NOT NULL REFERENCES master_vendors(id) ON DELETE CASCADE,
  template_name TEXT NOT NULL,
  field_mappings JSONB NOT NULL DEFAULT '{}',  -- position mappings for fields
  sample_document_url TEXT,
  match_count INT NOT NULL DEFAULT 0,  -- how many docs matched this template
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- CORE DOCUMENT PROCESSING TABLES
-- ============================================================

-- Main Documents Table (tracks entire lifecycle)
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Source info
  source document_source NOT NULL,
  source_identifier TEXT,  -- email address, phone number, folder path
  original_filename TEXT,
  file_url TEXT NOT NULL,  -- S3/Supabase Storage URL
  file_size_bytes BIGINT,
  file_mime_type TEXT,
  
  -- Classification
  document_type document_type NOT NULL DEFAULT 'unknown',
  classification_confidence NUMERIC(5, 4),  -- 0.0000 to 1.0000
  
  -- Processing status
  status document_status NOT NULL DEFAULT 'new',
  
  -- Metadata from source
  email_subject TEXT,
  email_sender TEXT,
  whatsapp_sender TEXT,
  whatsapp_message_id TEXT,
  scan_dpi INT,
  
  -- Processing timestamps
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  preprocessing_started_at TIMESTAMPTZ,
  preprocessing_completed_at TIMESTAMPTZ,
  ocr_started_at TIMESTAMPTZ,
  ocr_completed_at TIMESTAMPTZ,
  parsing_started_at TIMESTAMPTZ,
  parsing_completed_at TIMESTAMPTZ,
  validation_started_at TIMESTAMPTZ,
  validation_completed_at TIMESTAMPTZ,
  exported_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  
  -- Processing metrics
  total_processing_time_ms INT,  -- total ms from received to valid/exception
  ocr_confidence_avg NUMERIC(5, 4),
  
  -- Error info
  error_message TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  max_retries INT NOT NULL DEFAULT 3,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_documents_source ON documents(source);
CREATE INDEX idx_documents_type ON documents(document_type);
CREATE INDEX idx_documents_received_at ON documents(received_at DESC);
CREATE INDEX idx_documents_status_type ON documents(status, document_type);

-- Preprocessed Images
CREATE TABLE document_preprocessed (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  preprocessed_file_url TEXT NOT NULL,
  operations_applied JSONB NOT NULL DEFAULT '[]',  -- ["auto_rotate", "deskew", "noise_removal", "contrast"]
  original_orientation INT,  -- degrees rotated
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_preprocessed_doc ON document_preprocessed(document_id);

-- OCR Results
CREATE TABLE document_ocr_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  
  raw_text TEXT,  -- full extracted text
  raw_response JSONB,  -- complete Google Vision API response
  
  -- Confidence metrics
  overall_confidence NUMERIC(5, 4),
  word_count INT,
  low_confidence_words INT,  -- words below 0.80 confidence
  
  -- Table detection
  tables_detected INT DEFAULT 0,
  table_data JSONB,  -- structured table data
  
  ocr_engine TEXT NOT NULL DEFAULT 'google_vision',
  processing_time_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ocr_results_doc ON document_ocr_results(document_id);

-- ============================================================
-- EXTRACTED DATA: INVOICES
-- ============================================================

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  
  -- Header fields (SRS 4.2.3)
  invoice_number TEXT,
  invoice_date DATE,
  vendor_name_raw TEXT,  -- as extracted from document
  vendor_id UUID REFERENCES master_vendors(id),
  vendor_code_raw TEXT,
  
  bill_to_name TEXT,
  bill_to_address TEXT,
  customer_id UUID REFERENCES master_customers(id),
  
  -- Totals
  subtotal NUMERIC(12, 2),
  tax_amount NUMERIC(12, 2),
  total_amount NUMERIC(12, 2),
  
  -- Payment
  payment_terms TEXT,
  due_date DATE,
  currency TEXT DEFAULT 'USD',
  
  -- Confidence scores per field
  field_confidences JSONB DEFAULT '{}',
  
  -- Flags
  is_duplicate BOOLEAN NOT NULL DEFAULT false,
  duplicate_of_id UUID REFERENCES invoices(id),
  needs_review BOOLEAN NOT NULL DEFAULT false,
  
  -- Template used
  vendor_template_id UUID REFERENCES vendor_templates(id),
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_document ON invoices(document_id);
CREATE INDEX idx_invoices_number ON invoices(invoice_number);
CREATE INDEX idx_invoices_vendor ON invoices(vendor_id);
CREATE INDEX idx_invoices_date ON invoices(invoice_date DESC);

-- Invoice Line Items
CREATE TABLE invoice_line_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_number INT NOT NULL,
  
  -- Extracted fields
  description TEXT,
  sku_raw TEXT,  -- as extracted from document
  sku_id UUID REFERENCES master_skus(id),  -- matched SKU
  quantity NUMERIC(12, 3),
  unit_price NUMERIC(12, 2),
  line_total NUMERIC(12, 2),
  
  -- Confidence
  field_confidences JSONB DEFAULT '{}',
  
  -- Validation
  math_valid BOOLEAN,  -- qty * unit_price = line_total
  sku_matched BOOLEAN NOT NULL DEFAULT false,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoice_lines_invoice ON invoice_line_items(invoice_id);

-- ============================================================
-- EXTRACTED DATA: ORDERS
-- ============================================================

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  
  -- Header fields (SRS 4.2.3)
  order_number TEXT,
  order_date DATE,
  customer_name_raw TEXT,  -- as extracted
  customer_id UUID REFERENCES master_customers(id),
  customer_code_raw TEXT,
  
  ship_to_address TEXT,
  
  -- Totals
  order_total NUMERIC(12, 2),
  currency TEXT DEFAULT 'USD',
  
  -- Delivery
  delivery_date DATE,
  special_instructions TEXT,
  
  -- Confidence
  field_confidences JSONB DEFAULT '{}',
  
  -- Flags
  is_duplicate BOOLEAN NOT NULL DEFAULT false,
  duplicate_of_id UUID REFERENCES orders(id),
  needs_review BOOLEAN NOT NULL DEFAULT false,
  requires_approval BOOLEAN NOT NULL DEFAULT false,  -- orders > $10,000
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_document ON orders(document_id);
CREATE INDEX idx_orders_number ON orders(order_number);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_date ON orders(order_date DESC);

-- Order Line Items
CREATE TABLE order_line_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_number INT NOT NULL,
  
  description TEXT,
  sku_raw TEXT,
  sku_id UUID REFERENCES master_skus(id),
  quantity NUMERIC(12, 3),
  unit_price NUMERIC(12, 2),
  line_total NUMERIC(12, 2),
  
  field_confidences JSONB DEFAULT '{}',
  sku_matched BOOLEAN NOT NULL DEFAULT false,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_lines_order ON order_line_items(order_id);

-- ============================================================
-- VALIDATION
-- ============================================================

CREATE TABLE validation_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  
  check_type validation_check_type NOT NULL,
  check_name TEXT NOT NULL,  -- human readable check description
  passed BOOLEAN NOT NULL,
  severity TEXT NOT NULL DEFAULT 'error',  -- 'error', 'warning', 'info'
  message TEXT,  -- detailed result message
  field_name TEXT,  -- which field failed
  expected_value TEXT,
  actual_value TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_validation_document ON validation_results(document_id);
CREATE INDEX idx_validation_passed ON validation_results(document_id, passed);

-- ============================================================
-- EXCEPTION MANAGEMENT (SRS 4.5)
-- ============================================================

CREATE TABLE exceptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  
  status exception_status NOT NULL DEFAULT 'pending',
  priority exception_priority NOT NULL DEFAULT 'medium',
  
  -- What went wrong
  reason TEXT NOT NULL,
  failed_checks JSONB DEFAULT '[]',  -- list of failed validation check IDs
  
  -- Review
  assigned_to UUID REFERENCES user_profiles(id),
  reviewed_by UUID REFERENCES user_profiles(id),
  reviewed_at TIMESTAMPTZ,
  
  -- Resolution
  resolution_notes TEXT,
  corrections_made JSONB DEFAULT '{}',  -- field: {old_value, new_value}
  
  -- Time tracking
  review_time_seconds INT,  -- how long the review took
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_exceptions_status ON exceptions(status);
CREATE INDEX idx_exceptions_priority ON exceptions(priority);
CREATE INDEX idx_exceptions_document ON exceptions(document_id);
CREATE INDEX idx_exceptions_assigned ON exceptions(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX idx_exceptions_pending ON exceptions(status, priority) WHERE status = 'pending';

-- Exception Comments
CREATE TABLE exception_comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exception_id UUID NOT NULL REFERENCES exceptions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_profiles(id),
  comment TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_exception_comments_exception ON exception_comments(exception_id);

-- ============================================================
-- SILO WMS INTEGRATION (SRS 4.4)
-- ============================================================

CREATE TABLE silo_exports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  export_type TEXT NOT NULL,  -- 'invoice' or 'order'
  status export_status NOT NULL DEFAULT 'pending',
  
  -- File info
  csv_filename TEXT,  -- [TYPE]_YYYYMMDD_HHMMSS.csv
  csv_file_url TEXT,
  record_count INT NOT NULL DEFAULT 0,
  
  -- Documents included in this export batch
  document_ids UUID[] NOT NULL DEFAULT '{}',
  
  -- Processing
  generated_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  
  -- Error handling
  error_message TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_silo_exports_status ON silo_exports(status);
CREATE INDEX idx_silo_exports_type ON silo_exports(export_type);

-- Track which documents are in which export
CREATE TABLE silo_export_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  export_id UUID NOT NULL REFERENCES silo_exports(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES documents(id),
  
  -- The actual CSV row data sent to Silo
  silo_data JSONB NOT NULL,  -- mapped fields per SRS 4.4.2
  row_number INT,
  
  import_status TEXT DEFAULT 'pending',  -- pending, success, failed
  import_error TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_silo_export_items_export ON silo_export_items(export_id);
CREATE INDEX idx_silo_export_items_document ON silo_export_items(document_id);

-- ============================================================
-- AUDIT & LOGGING (SRS 4.6)
-- ============================================================

-- Processing Logs (system-level)
CREATE TABLE processing_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  
  log_level TEXT NOT NULL DEFAULT 'info',  -- debug, info, warn, error
  stage TEXT NOT NULL,  -- ingestion, preprocessing, ocr, parsing, validation, export
  message TEXT NOT NULL,
  details JSONB,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_processing_logs_document ON processing_logs(document_id);
CREATE INDEX idx_processing_logs_level ON processing_logs(log_level);
CREATE INDEX idx_processing_logs_created ON processing_logs(created_at DESC);

-- Audit Trail (user actions)
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  user_id UUID REFERENCES user_profiles(id),
  action TEXT NOT NULL,  -- e.g. 'exception.approve', 'document.reprocess', 'master.sku_add'
  entity_type TEXT NOT NULL,  -- 'document', 'exception', 'invoice', 'order', 'master_sku', etc.
  entity_id UUID,
  
  old_values JSONB,
  new_values JSONB,
  
  ip_address INET,
  user_agent TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);

-- Daily Processing Summary (for reporting - SRS 4.6)
CREATE TABLE daily_summaries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  summary_date DATE NOT NULL UNIQUE,
  
  total_received INT NOT NULL DEFAULT 0,
  total_processed INT NOT NULL DEFAULT 0,
  total_successful INT NOT NULL DEFAULT 0,
  total_exceptions INT NOT NULL DEFAULT 0,
  total_failed INT NOT NULL DEFAULT 0,
  
  -- By source
  from_email INT NOT NULL DEFAULT 0,
  from_whatsapp INT NOT NULL DEFAULT 0,
  from_scanner INT NOT NULL DEFAULT 0,
  from_cloud INT NOT NULL DEFAULT 0,
  
  -- By type
  invoices_count INT NOT NULL DEFAULT 0,
  orders_count INT NOT NULL DEFAULT 0,
  receipts_count INT NOT NULL DEFAULT 0,
  
  -- Accuracy
  accuracy_rate NUMERIC(5, 2),  -- percentage
  avg_processing_time_ms INT,
  avg_confidence NUMERIC(5, 4),
  
  -- Silo exports
  total_exported INT NOT NULL DEFAULT 0,
  export_failures INT NOT NULL DEFAULT 0,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_daily_summaries_date ON daily_summaries(summary_date DESC);

-- ============================================================
-- NOTIFICATION QUEUE
-- ============================================================

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  recipient_user_id UUID REFERENCES user_profiles(id),
  recipient_email TEXT,
  
  notification_type TEXT NOT NULL,  -- 'exception_alert', 'daily_summary', 'export_failure', 'approval_required'
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  
  is_sent BOOLEAN NOT NULL DEFAULT false,
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_unsent ON notifications(is_sent) WHERE is_sent = false;

-- ============================================================
-- UPDATED_AT TRIGGER FUNCTION
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
CREATE TRIGGER trg_user_profiles_updated_at BEFORE UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_master_skus_updated_at BEFORE UPDATE ON master_skus FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_master_customers_updated_at BEFORE UPDATE ON master_customers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_master_vendors_updated_at BEFORE UPDATE ON master_vendors FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_vendor_templates_updated_at BEFORE UPDATE ON vendor_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_documents_updated_at BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_exceptions_updated_at BEFORE UPDATE ON exceptions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_silo_exports_updated_at BEFORE UPDATE ON silo_exports FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_daily_summaries_updated_at BEFORE UPDATE ON daily_summaries FOR EACH ROW EXECUTE FUNCTION update_updated_at();
