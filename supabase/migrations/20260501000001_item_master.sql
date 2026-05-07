-- ============================================================
-- ITEM MASTER (synced from Silo WMS)
-- ============================================================
-- Persistent copy of Silo's product / inventory catalog. Populated by
-- /api/item-master/sync (or scripts/sync-item-master.js). Queried by:
--   • /api/item-master                   (Item Master dashboard page)
--   • /api/orders/new enrichment         (matches OCR/LLM extracted lines)
-- ============================================================

CREATE TABLE IF NOT EXISTS item_master (
  -- Stable Silo product id (or inventory id if product is null)
  id              TEXT PRIMARY KEY,

  -- Canonical SKU / barcodes
  sku_code        TEXT,            -- inventory.lookupCode
  upc             TEXT,
  plu             TEXT,

  -- Descriptive
  description     TEXT,            -- product.name
  group_name      TEXT,            -- inventory.displayGroup
  location        TEXT,            -- inventory.warehouseLocation

  -- Stock + price
  on_hand         NUMERIC(14,3),
  unit_price      NUMERIC(12,2),

  -- Sync metadata
  source          TEXT NOT NULL DEFAULT 'silo',
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookup-friendly indexes for the orders matcher
CREATE INDEX IF NOT EXISTS idx_item_master_sku_lower
  ON item_master ((LOWER(sku_code)));
CREATE INDEX IF NOT EXISTS idx_item_master_upc_lower
  ON item_master ((LOWER(upc)));
CREATE INDEX IF NOT EXISTS idx_item_master_desc_lower
  ON item_master ((LOWER(description)));
CREATE INDEX IF NOT EXISTS idx_item_master_group
  ON item_master (group_name);

-- updated_at trigger reuses the shared helper function defined in
-- 20260410100000_denormalized_schema.sql.
DROP TRIGGER IF EXISTS trg_item_master_updated ON item_master;
CREATE TRIGGER trg_item_master_updated
  BEFORE UPDATE ON item_master
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: keep parity with the rest of the schema (denormalized + RBAC handled
-- in app code; service role bypasses these policies anyway).
ALTER TABLE item_master ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "item_master_read_all" ON item_master;
CREATE POLICY "item_master_read_all" ON item_master
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "item_master_admin_write" ON item_master;
CREATE POLICY "item_master_admin_write" ON item_master
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE auth_user_id = auth.uid() AND role = 'admin')
  );
