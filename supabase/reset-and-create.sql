-- ============================================================
-- VANA GRP — Complete Database Reset + New Schema
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- STEP 1: Drop ALL existing views
DROP VIEW IF EXISTS v_today_stats CASCADE;
DROP VIEW IF EXISTS v_pending_exceptions CASCADE;
DROP VIEW IF EXISTS v_document_pipeline CASCADE;
DROP VIEW IF EXISTS v_monthly_summary CASCADE;

-- STEP 2: Drop ALL existing tables (order matters due to FK)
DROP TABLE IF EXISTS silo_export_items CASCADE;
DROP TABLE IF EXISTS silo_exports CASCADE;
DROP TABLE IF EXISTS exception_comments CASCADE;
DROP TABLE IF EXISTS exceptions CASCADE;
DROP TABLE IF EXISTS validation_results CASCADE;
DROP TABLE IF EXISTS processing_logs CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS document_ocr_results CASCADE;
DROP TABLE IF EXISTS document_preprocessed CASCADE;
DROP TABLE IF EXISTS invoice_line_items CASCADE;
DROP TABLE IF EXISTS invoice_lines CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS order_line_items CASCADE;
DROP TABLE IF EXISTS order_lines CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS master_skus CASCADE;
DROP TABLE IF EXISTS master_vendors CASCADE;
DROP TABLE IF EXISTS master_customers CASCADE;
DROP TABLE IF EXISTS documents CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- STEP 3: Drop ALL existing functions
DROP FUNCTION IF EXISTS update_updated_at() CASCADE;
DROP FUNCTION IF EXISTS get_user_role() CASCADE;
DROP FUNCTION IF EXISTS fn_auto_create_user() CASCADE;

-- STEP 4: Drop any existing types/enums
DROP TYPE IF EXISTS document_status CASCADE;
DROP TYPE IF EXISTS document_source CASCADE;
DROP TYPE IF EXISTS document_type CASCADE;
DROP TYPE IF EXISTS validation_severity CASCADE;
DROP TYPE IF EXISTS exception_status CASCADE;
DROP TYPE IF EXISTS user_role CASCADE;

-- ============================================================
-- NOW CREATE NEW DENORMALIZED SCHEMA (6 TABLES)
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================
-- TABLE 1: USERS
-- ============================================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id UUID UNIQUE,
  email TEXT UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'read_only' CHECK (role IN ('admin', 'reviewer', 'read_only')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  preferences JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- ============================================================
-- TABLE 2: DOCUMENTS
-- ============================================================
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source TEXT NOT NULL CHECK (source IN ('email', 'whatsapp', 'scanner', 'cloud_upload', 'google_drive')),
  source_identifier TEXT,
  original_filename TEXT,
  file_url TEXT NOT NULL,
  file_size_bytes BIGINT,
  file_mime_type TEXT,
  document_type TEXT NOT NULL DEFAULT 'unknown' CHECK (document_type IN ('invoice', 'order', 'receipt', 'unstructured', 'unknown')),
  classification_confidence NUMERIC(5,4),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new', 'processing', 'extracted', 'validated',
    'exception', 'approved', 'ready_for_export', 'exported', 'failed'
  )),
  email_subject TEXT,
  email_sender TEXT,
  whatsapp_sender TEXT,
  whatsapp_message_id TEXT,
  scan_dpi INT,
  ocr_raw_text TEXT,
  ocr_confidence NUMERIC(5,4),
  ocr_language TEXT,
  ocr_word_count INT,
  ocr_blocks JSONB,
  preprocessed_file_url TEXT,
  preprocessing_ops JSONB,
  processing_log JSONB NOT NULL DEFAULT '[]',
  total_processing_time_ms INT,
  error_message TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  exported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_documents_source ON documents(source);
CREATE INDEX idx_documents_type ON documents(document_type);
CREATE INDEX idx_documents_received ON documents(received_at DESC);
CREATE INDEX idx_documents_source_identifier ON documents(source_identifier);

-- ============================================================
-- TABLE 3: INVOICES
-- ============================================================
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  invoice_number TEXT,
  invoice_date DATE,
  due_date DATE,
  payment_terms TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  vendor_name TEXT,
  vendor_code TEXT,
  vendor_address TEXT,
  vendor_gstin TEXT,
  vendor_email TEXT,
  vendor_phone TEXT,
  bill_to_name TEXT,
  bill_to_address TEXT,
  subtotal NUMERIC(12,2),
  tax_amount NUMERIC(12,2),
  discount_amount NUMERIC(12,2) DEFAULT 0,
  total_amount NUMERIC(12,2),
  field_confidences JSONB DEFAULT '{}',
  validation_status TEXT DEFAULT 'pending' CHECK (validation_status IN ('pending', 'passed', 'failed')),
  validation_checks JSONB DEFAULT '[]',
  validation_errors INT DEFAULT 0,
  validation_warnings INT DEFAULT 0,
  exception_status TEXT CHECK (exception_status IN ('pending', 'in_review', 'approved', 'rejected', NULL)),
  exception_priority TEXT CHECK (exception_priority IN ('low', 'medium', 'high', 'critical', NULL)),
  exception_reason TEXT,
  exception_assigned_to UUID REFERENCES users(id),
  exception_reviewed_by UUID REFERENCES users(id),
  exception_reviewed_at TIMESTAMPTZ,
  exception_notes TEXT,
  exception_comments JSONB DEFAULT '[]',
  corrections_made JSONB DEFAULT '{}',
  is_duplicate BOOLEAN NOT NULL DEFAULT false,
  export_status TEXT DEFAULT 'pending' CHECK (export_status IN ('pending', 'exported', 'confirmed', 'failed', NULL)),
  export_batch_id TEXT,
  export_csv_url TEXT,
  exported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_document ON invoices(document_id);
CREATE INDEX idx_invoices_number ON invoices(invoice_number);
CREATE INDEX idx_invoices_vendor ON invoices(vendor_name);
CREATE INDEX idx_invoices_date ON invoices(invoice_date DESC);
CREATE INDEX idx_invoices_status ON invoices(validation_status);
CREATE INDEX idx_invoices_exception ON invoices(exception_status) WHERE exception_status IS NOT NULL;
CREATE INDEX idx_invoices_export ON invoices(export_status);

-- ============================================================
-- TABLE 4: INVOICE_LINES
-- ============================================================
CREATE TABLE invoice_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_number INT NOT NULL,
  description TEXT,
  sku_code TEXT,
  sku_name TEXT,
  hsn_code TEXT,
  unit_of_measure TEXT,
  quantity NUMERIC(12,3),
  unit_price NUMERIC(12,2),
  discount NUMERIC(12,2) DEFAULT 0,
  tax_rate NUMERIC(5,2),
  tax_amount NUMERIC(12,2),
  line_total NUMERIC(12,2),
  sku_matched BOOLEAN NOT NULL DEFAULT false,
  math_valid BOOLEAN,
  field_confidences JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoice_lines_invoice ON invoice_lines(invoice_id);
CREATE INDEX idx_invoice_lines_sku ON invoice_lines(sku_code);

-- ============================================================
-- TABLE 5: ORDERS
-- ============================================================
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  order_number TEXT,
  order_date DATE,
  delivery_date DATE,
  payment_terms TEXT,
  special_instructions TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  customer_name TEXT,
  customer_code TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  customer_whatsapp TEXT,
  billing_address TEXT,
  shipping_address TEXT,
  subtotal NUMERIC(12,2),
  tax_amount NUMERIC(12,2),
  total_amount NUMERIC(12,2),
  field_confidences JSONB DEFAULT '{}',
  validation_status TEXT DEFAULT 'pending' CHECK (validation_status IN ('pending', 'passed', 'failed')),
  validation_checks JSONB DEFAULT '[]',
  validation_errors INT DEFAULT 0,
  validation_warnings INT DEFAULT 0,
  exception_status TEXT CHECK (exception_status IN ('pending', 'in_review', 'approved', 'rejected', NULL)),
  exception_priority TEXT CHECK (exception_priority IN ('low', 'medium', 'high', 'critical', NULL)),
  exception_reason TEXT,
  exception_assigned_to UUID REFERENCES users(id),
  exception_reviewed_by UUID REFERENCES users(id),
  exception_reviewed_at TIMESTAMPTZ,
  exception_notes TEXT,
  exception_comments JSONB DEFAULT '[]',
  corrections_made JSONB DEFAULT '{}',
  is_duplicate BOOLEAN NOT NULL DEFAULT false,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  export_status TEXT DEFAULT 'pending' CHECK (export_status IN ('pending', 'exported', 'confirmed', 'failed', NULL)),
  export_batch_id TEXT,
  export_csv_url TEXT,
  exported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_document ON orders(document_id);
CREATE INDEX idx_orders_number ON orders(order_number);
CREATE INDEX idx_orders_customer ON orders(customer_name);
CREATE INDEX idx_orders_date ON orders(order_date DESC);
CREATE INDEX idx_orders_status ON orders(validation_status);
CREATE INDEX idx_orders_exception ON orders(exception_status) WHERE exception_status IS NOT NULL;
CREATE INDEX idx_orders_export ON orders(export_status);

-- ============================================================
-- TABLE 6: ORDER_LINES
-- ============================================================
CREATE TABLE order_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_number INT NOT NULL,
  description TEXT,
  sku_code TEXT,
  sku_name TEXT,
  unit_of_measure TEXT,
  quantity NUMERIC(12,3),
  unit_price NUMERIC(12,2),
  line_total NUMERIC(12,2),
  sku_matched BOOLEAN NOT NULL DEFAULT false,
  field_confidences JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_lines_order ON order_lines(order_id);
CREATE INDEX idx_order_lines_sku ON order_lines(sku_code);

-- ============================================================
-- TRIGGERS
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_documents_updated BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_invoices_updated BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_lines ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION get_user_role()
RETURNS TEXT AS $$
  SELECT role FROM users WHERE auth_user_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- USERS
CREATE POLICY "users_read" ON users FOR SELECT USING (true);
CREATE POLICY "users_admin" ON users FOR ALL USING (get_user_role() = 'admin');

-- DOCUMENTS
CREATE POLICY "documents_read" ON documents FOR SELECT USING (true);
CREATE POLICY "documents_insert" ON documents FOR INSERT WITH CHECK (
  get_user_role() IN ('admin', 'reviewer')
);
CREATE POLICY "documents_update" ON documents FOR UPDATE USING (
  get_user_role() IN ('admin', 'reviewer')
);

-- INVOICES
CREATE POLICY "invoices_read" ON invoices FOR SELECT USING (true);
CREATE POLICY "invoices_write" ON invoices FOR ALL USING (
  get_user_role() IN ('admin', 'reviewer')
);

-- INVOICE_LINES
CREATE POLICY "invoice_lines_read" ON invoice_lines FOR SELECT USING (true);
CREATE POLICY "invoice_lines_write" ON invoice_lines FOR ALL USING (
  get_user_role() IN ('admin', 'reviewer')
);

-- ORDERS
CREATE POLICY "orders_read" ON orders FOR SELECT USING (true);
CREATE POLICY "orders_write" ON orders FOR ALL USING (
  get_user_role() IN ('admin', 'reviewer')
);

-- ORDER_LINES
CREATE POLICY "order_lines_read" ON order_lines FOR SELECT USING (true);
CREATE POLICY "order_lines_write" ON order_lines FOR ALL USING (
  get_user_role() IN ('admin', 'reviewer')
);

-- ============================================================
-- VIEWS
-- ============================================================
CREATE OR REPLACE VIEW v_today_stats AS
SELECT
  COUNT(*) AS total_today,
  COUNT(*) FILTER (WHERE status IN ('validated', 'ready_for_export', 'exported')) AS successful,
  COUNT(*) FILTER (WHERE status = 'exception') AS exceptions,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
  COUNT(*) FILTER (WHERE status IN ('new', 'processing', 'extracted')) AS in_progress,
  ROUND(AVG(total_processing_time_ms)) AS avg_processing_ms,
  ROUND(AVG(ocr_confidence)::numeric, 4) AS avg_confidence,
  COUNT(*) FILTER (WHERE source = 'email') AS from_email,
  COUNT(*) FILTER (WHERE source = 'whatsapp') AS from_whatsapp,
  COUNT(*) FILTER (WHERE source = 'scanner') AS from_scanner,
  COUNT(*) FILTER (WHERE source IN ('cloud_upload', 'google_drive')) AS from_cloud
FROM documents
WHERE received_at >= CURRENT_DATE;

CREATE OR REPLACE VIEW v_pending_exceptions AS
SELECT
  d.id AS document_id,
  d.source,
  d.document_type,
  d.original_filename,
  d.file_url,
  d.received_at,
  d.ocr_confidence,
  COALESCE(i.id, o.id) AS record_id,
  COALESCE(i.invoice_number, o.order_number) AS reference_number,
  COALESCE(i.total_amount, o.total_amount) AS total_amount,
  COALESCE(i.vendor_name, o.customer_name) AS party_name,
  COALESCE(i.exception_status, o.exception_status) AS exception_status,
  COALESCE(i.exception_priority, o.exception_priority) AS exception_priority,
  COALESCE(i.exception_reason, o.exception_reason) AS exception_reason,
  COALESCE(i.exception_assigned_to, o.exception_assigned_to) AS assigned_to,
  COALESCE(i.created_at, o.created_at) AS exception_created_at
FROM documents d
LEFT JOIN invoices i ON i.document_id = d.id AND i.exception_status IN ('pending', 'in_review')
LEFT JOIN orders o ON o.document_id = d.id AND o.exception_status IN ('pending', 'in_review')
WHERE d.status = 'exception'
  AND (i.id IS NOT NULL OR o.id IS NOT NULL)
ORDER BY
  CASE COALESCE(i.exception_priority, o.exception_priority)
    WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4
  END,
  d.received_at DESC;

-- ============================================================
-- DONE! Verify with: SELECT tablename FROM pg_tables WHERE schemaname = 'public';
-- ============================================================
