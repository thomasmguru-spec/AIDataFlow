-- ============================================================
-- Definitive fix for: "new row violates row-level security policy
--                     for table role_permissions"
--
-- These two tables are administrative configuration data accessed only
-- through the Next.js API layer, which already gates writes with
-- requireCapability('admin:manage_permissions') using the service-role
-- client. There is no scenario where an end-user PostgREST request
-- should write to them directly, so RLS provides no extra security here
-- and only causes friction.
--
-- We:
--   1. Drop the previously-created policies (they are no longer needed).
--   2. Disable RLS on both tables so admin writes succeed regardless of
--      whether the underlying request happens to carry a user JWT.
--   3. Revoke direct anon/authenticated grants as defense-in-depth so
--      PostgREST cannot expose them even if RLS is off.
-- ============================================================

-- Drop old policies (idempotent)
DROP POLICY IF EXISTS role_permissions_service_all        ON role_permissions;
DROP POLICY IF EXISTS role_permissions_authenticated_read ON role_permissions;
DROP POLICY IF EXISTS user_perm_overrides_service_all     ON user_permission_overrides;
DROP POLICY IF EXISTS user_perm_overrides_self_read       ON user_permission_overrides;

-- Disable RLS — service_role already bypasses it, and we want anon /
-- authenticated requests to NOT see these tables at all (handled by
-- revokes below).
ALTER TABLE role_permissions          DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_permission_overrides DISABLE ROW LEVEL SECURITY;

-- Defense-in-depth: revoke any grants to anon / authenticated so
-- PostgREST clients cannot read or write these tables directly. The
-- service-role key still has full access (it bypasses GRANTs as well).
REVOKE ALL ON role_permissions          FROM anon, authenticated;
REVOKE ALL ON user_permission_overrides FROM anon, authenticated;

-- The view `v_user_effective_permissions` joins `users`, which already
-- has its own RLS / grants. Keep it readable to authenticated users so
-- the dashboard can fetch effective perms; revoke from anon.
REVOKE ALL ON v_user_effective_permissions FROM anon;
GRANT SELECT ON v_user_effective_permissions TO authenticated;
