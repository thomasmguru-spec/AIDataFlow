-- ============================================================
-- RLS policies for the new RBAC tables.
--
-- Why: the service-role key bypasses RLS, but anon / authenticated
-- writes hit the policy layer. The previous migration left RLS in its
-- default state (enabled by Supabase template) without policies, so
-- INSERTs from the API failed with:
--   "new row violates row-level security policy for table role_permissions"
--
-- Strategy:
--   * Enable RLS explicitly so behavior is consistent across envs.
--   * Allow service_role full access (admin API uses service-role key).
--   * Allow authenticated users to SELECT (so the UI can read its own
--     effective permissions); writes are admin-only via the API.
-- ============================================================

ALTER TABLE role_permissions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permission_overrides ENABLE ROW LEVEL SECURITY;

-- Drop policies first to keep this migration idempotent.
DROP POLICY IF EXISTS role_permissions_service_all       ON role_permissions;
DROP POLICY IF EXISTS role_permissions_authenticated_read ON role_permissions;
DROP POLICY IF EXISTS user_perm_overrides_service_all    ON user_permission_overrides;
DROP POLICY IF EXISTS user_perm_overrides_self_read      ON user_permission_overrides;

-- role_permissions: full access for service_role, read for any
-- authenticated user (the matrix is not sensitive and the UI needs it).
CREATE POLICY role_permissions_service_all
  ON role_permissions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY role_permissions_authenticated_read
  ON role_permissions
  FOR SELECT
  TO authenticated
  USING (true);

-- user_permission_overrides: full access for service_role; an
-- authenticated user may read their own overrides.
CREATE POLICY user_perm_overrides_service_all
  ON user_permission_overrides
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY user_perm_overrides_self_read
  ON user_permission_overrides
  FOR SELECT
  TO authenticated
  USING (
    user_id IN (
      SELECT id FROM users WHERE auth_user_id = auth.uid()
    )
  );
