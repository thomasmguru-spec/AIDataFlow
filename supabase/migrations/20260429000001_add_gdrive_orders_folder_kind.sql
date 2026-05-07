-- ─────────────────────────────────────────────────────────────────────────────
-- 20260429000001_add_gdrive_orders_folder_kind.sql
--
-- Adds 'orders' to the allowed values of documents.gdrive_folder_kind.
--
-- Context:
--   The previous migration 20260423000001_vendor_invoices_and_returns.sql added
--   a CHECK constraint allowing only ('customer_invoices', 'vendor_invoices').
--   We now ingest a third Google Drive folder containing PURCHASE ORDERS from
--   customers (folder ID: 1j6JMz8o50nmln2mW1zbOd-5PYR_kxP-K). Documents from
--   that folder are imported with gdrive_folder_kind='orders' so the dashboard
--   "New Orders → Google Drive" tab can distinguish them from invoices.
--
-- Idempotent: drops the existing CHECK constraint (if present) and re-adds it
-- with the expanded value list.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_gdrive_folder_kind_check;

ALTER TABLE documents
  ADD CONSTRAINT documents_gdrive_folder_kind_check
  CHECK (gdrive_folder_kind IN ('customer_invoices', 'vendor_invoices', 'orders'));

COMMENT ON COLUMN documents.gdrive_folder_kind IS
  'Which Google Drive folder this document was imported from: '
  '''customer_invoices'' | ''vendor_invoices'' | ''orders''.';
