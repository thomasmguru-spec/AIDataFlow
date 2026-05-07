-- ============================================================
-- FIX: Resolve ambiguous "key" column reference in audit trigger
-- The DECLARE variable "key TEXT" conflicts with the jsonb_each alias "key"
-- causing all UPDATEs on audited tables to fail with error 42702
-- ============================================================

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
