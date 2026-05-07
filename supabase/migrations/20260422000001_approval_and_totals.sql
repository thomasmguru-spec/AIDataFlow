-- ============================================================
-- Approval workflow + auto-recompute totals
-- ============================================================

-- 1. Add approval workflow columns to invoices
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS approval_status TEXT
    CHECK (approval_status IN ('draft', 'under_review', 'approved', 'rejected'))
    DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_approval_status ON invoices(approval_status);

-- 2. Mirror approval columns on orders (manual approval optional)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS approval_status TEXT
    CHECK (approval_status IN ('draft', 'under_review', 'approved', 'rejected'))
    DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- 3. Auto-recompute invoice line totals when quantity / unit_price change
CREATE OR REPLACE FUNCTION fn_invoice_line_recalc()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.quantity IS NOT NULL AND NEW.unit_price IS NOT NULL THEN
    NEW.line_total := ROUND(
      (NEW.quantity * NEW.unit_price - COALESCE(NEW.discount, 0) + COALESCE(NEW.tax_amount, 0))::numeric,
      2
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoice_line_recalc ON invoice_lines;
CREATE TRIGGER trg_invoice_line_recalc
  BEFORE INSERT OR UPDATE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_line_recalc();

-- 4. Auto-recompute invoice totals when any line changes
CREATE OR REPLACE FUNCTION fn_invoice_recalc_totals()
RETURNS TRIGGER AS $$
DECLARE
  inv_id UUID;
  new_subtotal NUMERIC;
  new_tax NUMERIC;
  new_total NUMERIC;
BEGIN
  inv_id := COALESCE(NEW.invoice_id, OLD.invoice_id);

  SELECT
    COALESCE(SUM(quantity * unit_price), 0),
    COALESCE(SUM(tax_amount), 0)
  INTO new_subtotal, new_tax
  FROM invoice_lines
  WHERE invoice_id = inv_id;

  new_total := new_subtotal + new_tax
    - COALESCE((SELECT discount_amount FROM invoices WHERE id = inv_id), 0);

  UPDATE invoices
  SET subtotal     = new_subtotal,
      tax_amount   = new_tax,
      total_amount = new_total,
      updated_at   = now()
  WHERE id = inv_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoice_recalc_totals ON invoice_lines;
CREATE TRIGGER trg_invoice_recalc_totals
  AFTER INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_recalc_totals();

-- 5. Same for orders
CREATE OR REPLACE FUNCTION fn_order_line_recalc()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.quantity IS NOT NULL AND NEW.unit_price IS NOT NULL THEN
    NEW.line_total := ROUND((NEW.quantity * NEW.unit_price)::numeric, 2);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_line_recalc ON order_lines;
CREATE TRIGGER trg_order_line_recalc
  BEFORE INSERT OR UPDATE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION fn_order_line_recalc();

CREATE OR REPLACE FUNCTION fn_order_recalc_totals()
RETURNS TRIGGER AS $$
DECLARE
  ord_id UUID;
  new_subtotal NUMERIC;
  new_total NUMERIC;
BEGIN
  ord_id := COALESCE(NEW.order_id, OLD.order_id);

  SELECT COALESCE(SUM(quantity * unit_price), 0)
    INTO new_subtotal
  FROM order_lines
  WHERE order_id = ord_id;

  new_total := new_subtotal
    + COALESCE((SELECT tax_amount FROM orders WHERE id = ord_id), 0);

  UPDATE orders
  SET subtotal     = new_subtotal,
      total_amount = new_total,
      updated_at   = now()
  WHERE id = ord_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_recalc_totals ON order_lines;
CREATE TRIGGER trg_order_recalc_totals
  AFTER INSERT OR UPDATE OR DELETE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION fn_order_recalc_totals();
