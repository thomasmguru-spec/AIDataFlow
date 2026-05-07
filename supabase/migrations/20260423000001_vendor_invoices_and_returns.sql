-- ============================================================
-- Vendor Invoices folder + Returns/Adjustments support
-- ============================================================

-- ---------- 1. Multiple Google Drive folders on documents ----------
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS gdrive_folder_id   TEXT,
  ADD COLUMN IF NOT EXISTS gdrive_folder_kind TEXT
    CHECK (gdrive_folder_kind IN ('customer_invoices', 'vendor_invoices'))
    DEFAULT NULL;

-- Backfill existing google_drive rows as customer_invoices so legacy data
-- continues to show on the existing tab.
UPDATE documents
   SET gdrive_folder_kind = 'customer_invoices'
 WHERE source = 'google_drive' AND gdrive_folder_kind IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_gdrive_kind
  ON documents(gdrive_folder_kind)
  WHERE gdrive_folder_kind IS NOT NULL;

-- ---------- 2. Mark vendor invoices on the invoices table ----------
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS is_vendor_invoice BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS total_returns     NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_credits     NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_total_amount  NUMERIC(12,2);

CREATE INDEX IF NOT EXISTS idx_invoices_vendor_flag
  ON invoices(is_vendor_invoice) WHERE is_vendor_invoice = true;

-- ---------- 3. Returns/adjustments on invoice_lines ----------
ALTER TABLE invoice_lines
  ADD COLUMN IF NOT EXISTS returned_quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS return_date       DATE,
  ADD COLUMN IF NOT EXISTS return_reason     TEXT;

-- Sanity: returned_quantity may not exceed quantity
ALTER TABLE invoice_lines
  DROP CONSTRAINT IF EXISTS chk_invoice_lines_returned_qty;
ALTER TABLE invoice_lines
  ADD CONSTRAINT chk_invoice_lines_returned_qty
    CHECK (returned_quantity >= 0
           AND (quantity IS NULL OR returned_quantity <= quantity));

ALTER TABLE invoice_lines
  DROP CONSTRAINT IF EXISTS chk_invoice_lines_credit_amount;
ALTER TABLE invoice_lines
  ADD CONSTRAINT chk_invoice_lines_credit_amount
    CHECK (credit_amount >= 0);

-- ---------- 4. Window check (7-30 days) for returns ----------
CREATE OR REPLACE FUNCTION fn_invoice_line_validate_return()
RETURNS TRIGGER AS $$
DECLARE
  inv_date DATE;
  days_gap INT;
BEGIN
  IF NEW.return_date IS NOT NULL THEN
    SELECT invoice_date INTO inv_date FROM invoices WHERE id = NEW.invoice_id;
    IF inv_date IS NULL THEN
      -- Allow returns when invoice_date is unknown (manual review case)
      RETURN NEW;
    END IF;
    days_gap := (NEW.return_date - inv_date);
    IF days_gap < 7 OR days_gap > 30 THEN
      RAISE EXCEPTION 'Return date must be 7-30 days after invoice date (got % day gap)', days_gap
        USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoice_line_validate_return ON invoice_lines;
CREATE TRIGGER trg_invoice_line_validate_return
  BEFORE INSERT OR UPDATE OF return_date, returned_quantity, credit_amount
    ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_line_validate_return();

-- ---------- 5. Recompute line_total + credit-aware totals ----------
-- Replace the existing line recalc so credit_amount is subtracted from line_total.
CREATE OR REPLACE FUNCTION fn_invoice_line_recalc()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.quantity IS NOT NULL AND NEW.unit_price IS NOT NULL THEN
    NEW.line_total := ROUND(
      ( (NEW.quantity - COALESCE(NEW.returned_quantity, 0)) * NEW.unit_price
        - COALESCE(NEW.discount, 0)
        + COALESCE(NEW.tax_amount, 0)
        - COALESCE(NEW.credit_amount, 0)
      )::numeric,
      2
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Replace invoice totals recompute so net_total + total_returns are tracked.
CREATE OR REPLACE FUNCTION fn_invoice_recalc_totals()
RETURNS TRIGGER AS $$
DECLARE
  inv_id UUID;
  new_subtotal NUMERIC;
  new_tax      NUMERIC;
  new_credits  NUMERIC;
  new_total    NUMERIC;
BEGIN
  inv_id := COALESCE(NEW.invoice_id, OLD.invoice_id);

  SELECT
    COALESCE(SUM( (quantity - COALESCE(returned_quantity,0)) * unit_price ), 0),
    COALESCE(SUM(tax_amount), 0),
    COALESCE(SUM(credit_amount), 0)
  INTO new_subtotal, new_tax, new_credits
  FROM invoice_lines
  WHERE invoice_id = inv_id;

  new_total := new_subtotal + new_tax
    - COALESCE((SELECT discount_amount FROM invoices WHERE id = inv_id), 0)
    - new_credits;

  UPDATE invoices
  SET subtotal         = new_subtotal,
      tax_amount       = new_tax,
      total_credits    = new_credits,
      total_returns    = new_credits,
      total_amount     = new_total,
      net_total_amount = new_total,
      updated_at       = now()
  WHERE id = inv_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ---------- 6. RPC helper: record a return safely ----------
CREATE OR REPLACE FUNCTION apply_invoice_return(
  p_line_id     UUID,
  p_returned_qty NUMERIC,
  p_credit_amt   NUMERIC,
  p_return_date  DATE,
  p_reason       TEXT DEFAULT NULL
) RETURNS invoice_lines AS $$
DECLARE
  result invoice_lines;
BEGIN
  UPDATE invoice_lines
     SET returned_quantity = COALESCE(p_returned_qty, 0),
         credit_amount     = COALESCE(p_credit_amt, 0),
         return_date       = p_return_date,
         return_reason     = p_reason
   WHERE id = p_line_id
   RETURNING * INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION apply_invoice_return(UUID, NUMERIC, NUMERIC, DATE, TEXT) TO authenticated;
