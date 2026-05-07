-- ============================================================
-- Supabase Migration: Database Functions & Views
-- Utility functions for the application layer
-- ============================================================

-- ============================================================
-- VIEWS: Dashboard queries (SRS 4.5)
-- ============================================================

-- Pending exceptions with document info (main dashboard view)
CREATE VIEW v_pending_exceptions AS
SELECT 
  e.id AS exception_id,
  e.status AS exception_status,
  e.priority,
  e.reason,
  e.created_at AS exception_created_at,
  e.assigned_to,
  d.id AS document_id,
  d.source,
  d.document_type,
  d.original_filename,
  d.file_url,
  d.received_at,
  d.ocr_confidence_avg,
  COALESCE(i.invoice_number, o.order_number) AS reference_number,
  COALESCE(i.total_amount, o.order_total) AS total_amount,
  COALESCE(mv.vendor_name, mc.customer_name) AS party_name
FROM exceptions e
JOIN documents d ON d.id = e.document_id
LEFT JOIN invoices i ON i.document_id = d.id
LEFT JOIN orders o ON o.document_id = d.id
LEFT JOIN master_vendors mv ON mv.id = i.vendor_id
LEFT JOIN master_customers mc ON mc.id = o.customer_id
WHERE e.status IN ('pending', 'in_review')
ORDER BY 
  CASE e.priority 
    WHEN 'critical' THEN 1 
    WHEN 'high' THEN 2 
    WHEN 'medium' THEN 3 
    WHEN 'low' THEN 4 
  END,
  e.created_at ASC;

-- Document processing overview
CREATE VIEW v_document_overview AS
SELECT 
  d.id,
  d.source,
  d.document_type,
  d.status,
  d.original_filename,
  d.file_url,
  d.received_at,
  d.total_processing_time_ms,
  d.ocr_confidence_avg,
  d.error_message,
  COALESCE(i.invoice_number, o.order_number) AS reference_number,
  COALESCE(i.invoice_date, o.order_date) AS document_date,
  COALESCE(i.total_amount, o.order_total) AS total_amount,
  COALESCE(mv.vendor_name, mc.customer_name) AS party_name,
  (SELECT COUNT(*) FROM validation_results vr WHERE vr.document_id = d.id AND NOT vr.passed) AS failed_checks,
  (SELECT e.status FROM exceptions e WHERE e.document_id = d.id ORDER BY e.created_at DESC LIMIT 1) AS exception_status
FROM documents d
LEFT JOIN invoices i ON i.document_id = d.id
LEFT JOIN orders o ON o.document_id = d.id
LEFT JOIN master_vendors mv ON mv.id = i.vendor_id
LEFT JOIN master_customers mc ON mc.id = o.customer_id
ORDER BY d.received_at DESC;

-- Today's processing stats
CREATE VIEW v_today_stats AS
SELECT
  COUNT(*) AS total_today,
  COUNT(*) FILTER (WHERE status IN ('valid', 'exported', 'completed', 'archived')) AS successful,
  COUNT(*) FILTER (WHERE status = 'exception' OR status = 'in_review') AS exceptions,
  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
  COUNT(*) FILTER (WHERE status IN ('new', 'preprocessing', 'extracted', 'parsed', 'validating')) AS in_progress,
  ROUND(AVG(total_processing_time_ms)) AS avg_processing_ms,
  ROUND(AVG(ocr_confidence_avg)::numeric, 4) AS avg_confidence,
  COUNT(*) FILTER (WHERE source = 'email') AS from_email,
  COUNT(*) FILTER (WHERE source = 'whatsapp') AS from_whatsapp,
  COUNT(*) FILTER (WHERE source = 'scanner') AS from_scanner,
  COUNT(*) FILTER (WHERE source = 'cloud_upload') AS from_cloud
FROM documents
WHERE received_at >= CURRENT_DATE;

-- ============================================================
-- FUNCTIONS: Business Logic
-- ============================================================

-- Check for duplicate documents by invoice/order number
CREATE OR REPLACE FUNCTION check_duplicate_invoice(p_invoice_number TEXT, p_vendor_id UUID)
RETURNS TABLE(is_duplicate BOOLEAN, existing_id UUID) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    TRUE,
    i.id
  FROM invoices i
  WHERE i.invoice_number = p_invoice_number
    AND i.vendor_id = p_vendor_id
  LIMIT 1;
  
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, NULL::UUID;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- Fuzzy match SKU against master
CREATE OR REPLACE FUNCTION match_sku(p_sku_raw TEXT)
RETURNS TABLE(
  sku_id UUID, 
  item_code TEXT, 
  description TEXT, 
  similarity_score REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ms.id,
    ms.item_code,
    ms.description,
    GREATEST(
      similarity(ms.item_code, p_sku_raw),
      similarity(ms.description, p_sku_raw)
    ) AS sim_score
  FROM master_skus ms
  WHERE ms.is_active = true
    AND (
      ms.item_code ILIKE '%' || p_sku_raw || '%'
      OR ms.description ILIKE '%' || p_sku_raw || '%'
      OR similarity(ms.item_code, p_sku_raw) > 0.3
      OR similarity(ms.description, p_sku_raw) > 0.3
    )
  ORDER BY sim_score DESC
  LIMIT 5;
END;
$$ LANGUAGE plpgsql STABLE;

-- Fuzzy match customer
CREATE OR REPLACE FUNCTION match_customer(p_name TEXT, p_phone TEXT DEFAULT NULL)
RETURNS TABLE(
  customer_id UUID,
  customer_code TEXT,
  customer_name TEXT,
  similarity_score REAL
) AS $$
BEGIN
  -- First try exact phone match (WhatsApp)
  IF p_phone IS NOT NULL THEN
    RETURN QUERY
    SELECT mc.id, mc.customer_code, mc.customer_name, 1.0::REAL
    FROM master_customers mc
    WHERE mc.is_active = true
      AND (mc.phone = p_phone OR mc.whatsapp_number = p_phone)
    LIMIT 1;
    
    IF FOUND THEN RETURN; END IF;
  END IF;
  
  -- Fuzzy name match
  RETURN QUERY
  SELECT 
    mc.id,
    mc.customer_code,
    mc.customer_name,
    similarity(mc.customer_name, p_name) AS sim_score
  FROM master_customers mc
  WHERE mc.is_active = true
    AND (
      mc.customer_name ILIKE '%' || p_name || '%'
      OR mc.customer_code ILIKE '%' || p_name || '%'
      OR similarity(mc.customer_name, p_name) > 0.3
    )
  ORDER BY sim_score DESC
  LIMIT 5;
END;
$$ LANGUAGE plpgsql STABLE;

-- Fuzzy match vendor
CREATE OR REPLACE FUNCTION match_vendor(p_name TEXT)
RETURNS TABLE(
  vendor_id UUID,
  vendor_code TEXT,
  vendor_name TEXT,
  similarity_score REAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    mv.id,
    mv.vendor_code,
    mv.vendor_name,
    similarity(mv.vendor_name, p_name) AS sim_score
  FROM master_vendors mv
  WHERE mv.is_active = true
    AND (
      mv.vendor_name ILIKE '%' || p_name || '%'
      OR mv.vendor_code ILIKE '%' || p_name || '%'
      OR similarity(mv.vendor_name, p_name) > 0.3
    )
  ORDER BY sim_score DESC
  LIMIT 5;
END;
$$ LANGUAGE plpgsql STABLE;

-- Calculate daily summary (called by cron or n8n)
CREATE OR REPLACE FUNCTION generate_daily_summary(p_date DATE DEFAULT CURRENT_DATE - INTERVAL '1 day')
RETURNS void AS $$
BEGIN
  INSERT INTO daily_summaries (
    summary_date,
    total_received, total_processed, total_successful, total_exceptions, total_failed,
    from_email, from_whatsapp, from_scanner, from_cloud,
    invoices_count, orders_count, receipts_count,
    accuracy_rate, avg_processing_time_ms, avg_confidence,
    total_exported, export_failures
  )
  SELECT
    p_date,
    COUNT(*),
    COUNT(*) FILTER (WHERE status NOT IN ('new', 'preprocessing')),
    COUNT(*) FILTER (WHERE status IN ('valid', 'exported', 'completed', 'archived')),
    COUNT(*) FILTER (WHERE status IN ('exception', 'in_review')),
    COUNT(*) FILTER (WHERE status = 'failed'),
    COUNT(*) FILTER (WHERE source = 'email'),
    COUNT(*) FILTER (WHERE source = 'whatsapp'),
    COUNT(*) FILTER (WHERE source = 'scanner'),
    COUNT(*) FILTER (WHERE source = 'cloud_upload'),
    COUNT(*) FILTER (WHERE document_type = 'invoice'),
    COUNT(*) FILTER (WHERE document_type = 'order'),
    COUNT(*) FILTER (WHERE document_type = 'receipt'),
    ROUND(
      100.0 * COUNT(*) FILTER (WHERE status IN ('valid', 'exported', 'completed', 'archived'))
      / NULLIF(COUNT(*) FILTER (WHERE status NOT IN ('new', 'preprocessing')), 0),
      2
    ),
    ROUND(AVG(total_processing_time_ms)),
    ROUND(AVG(ocr_confidence_avg)::numeric, 4),
    COUNT(*) FILTER (WHERE status IN ('exported', 'completed')),
    0  -- export failures calculated separately
  FROM documents
  WHERE received_at >= p_date AND received_at < p_date + INTERVAL '1 day'
  ON CONFLICT (summary_date) DO UPDATE SET
    total_received = EXCLUDED.total_received,
    total_processed = EXCLUDED.total_processed,
    total_successful = EXCLUDED.total_successful,
    total_exceptions = EXCLUDED.total_exceptions,
    total_failed = EXCLUDED.total_failed,
    from_email = EXCLUDED.from_email,
    from_whatsapp = EXCLUDED.from_whatsapp,
    from_scanner = EXCLUDED.from_scanner,
    from_cloud = EXCLUDED.from_cloud,
    invoices_count = EXCLUDED.invoices_count,
    orders_count = EXCLUDED.orders_count,
    receipts_count = EXCLUDED.receipts_count,
    accuracy_rate = EXCLUDED.accuracy_rate,
    avg_processing_time_ms = EXCLUDED.avg_processing_time_ms,
    avg_confidence = EXCLUDED.avg_confidence,
    total_exported = EXCLUDED.total_exported,
    updated_at = now();
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- SUPABASE STORAGE BUCKETS
-- ============================================================

-- Create storage buckets for documents
INSERT INTO storage.buckets (id, name, public)
VALUES 
  ('original-documents', 'original-documents', false),
  ('preprocessed-documents', 'preprocessed-documents', false),
  ('silo-exports', 'silo-exports', false);

-- Storage policies: authenticated users can read, service role can write
CREATE POLICY "Authenticated users can read original docs"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'original-documents' AND auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can read preprocessed docs"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'preprocessed-documents' AND auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can read silo exports"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'silo-exports' AND auth.uid() IS NOT NULL);
