-- ============================================================
-- Add rejection_reason to orders (mirror of invoices)
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_approval_status ON orders(approval_status);
