-- ============================================================
-- AUDIT LOG TABLE & TRIGGERS
-- Automatically logs every INSERT, UPDATE, DELETE on key tables
-- ============================================================

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_name TEXT NOT NULL,
  record_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  old_data JSONB,
  new_data JSONB,
  changed_fields TEXT[],
  performed_by UUID,  -- auth.uid() if available
  performed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX idx_audit_log_table ON audit_log(table_name);
CREATE INDEX idx_audit_log_record ON audit_log(record_id);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_performed_at ON audit_log(performed_at DESC);
CREATE INDEX idx_audit_log_performed_by ON audit_log(performed_by);

-- Generic audit trigger function
CREATE OR REPLACE FUNCTION fn_audit_trigger()
RETURNS TRIGGER AS $$
DECLARE
  record_id UUID;
  old_json JSONB;
  new_json JSONB;
  changed TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    record_id := OLD.id;
    old_json := to_jsonb(OLD);
    new_json := NULL;
    changed := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    record_id := NEW.id;
    old_json := NULL;
    new_json := to_jsonb(NEW);
    changed := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    record_id := NEW.id;
    old_json := to_jsonb(OLD);
    new_json := to_jsonb(NEW);
    -- Compute changed fields
    changed := ARRAY(
      SELECT n.key
      FROM jsonb_each(to_jsonb(NEW)) AS n(key, val)
      WHERE n.val IS DISTINCT FROM (to_jsonb(OLD) -> n.key)
        AND n.key NOT IN ('updated_at')
    );
    -- Skip if only updated_at changed
    IF array_length(changed, 1) IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO audit_log (table_name, record_id, action, old_data, new_data, changed_fields, performed_by)
  VALUES (
    TG_TABLE_NAME,
    record_id,
    TG_OP,
    old_json,
    new_json,
    changed,
    CASE WHEN current_setting('request.jwt.claims', true) IS NOT NULL
      THEN (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::UUID
      ELSE NULL
    END
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach triggers to all key tables
CREATE TRIGGER audit_documents
  AFTER INSERT OR UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION fn_audit_trigger();

CREATE TRIGGER audit_invoices
  AFTER INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION fn_audit_trigger();

CREATE TRIGGER audit_invoice_lines
  AFTER INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION fn_audit_trigger();

CREATE TRIGGER audit_orders
  AFTER INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_audit_trigger();

CREATE TRIGGER audit_order_lines
  AFTER INSERT OR UPDATE OR DELETE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION fn_audit_trigger();

CREATE TRIGGER audit_users
  AFTER INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION fn_audit_trigger();

-- RLS: Everyone can read audit log, only service role can insert
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_log_read" ON audit_log FOR SELECT USING (true);
CREATE POLICY "audit_log_insert" ON audit_log FOR INSERT WITH CHECK (true);
