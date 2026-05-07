-- ============================================================
-- RBAC Permissions: role-level capability matrix + per-user overrides
--
-- Design:
--   * `role_permissions` stores which capabilities each role currently has
--     (admin-editable matrix). Seeded from the static matrix in
--     src/lib/auth/permissions.ts.
--   * `user_permission_overrides` lets the admin grant or revoke an
--     individual capability for a specific user, overriding the role
--     default. (granted = true grants extra; granted = false revokes.)
--   * Effective permission for a user = role_permissions[role][capability]
--     XOR'd with the user override if present (override wins).
--
-- Notes:
--   * Capabilities are stored as TEXT (no enum) so the matrix can grow
--     without schema migrations.
--   * Admin role is always allowed to manage users / permissions even if
--     the matrix is misconfigured (enforced at app layer as a safety
--     fallback) but seed makes sure 'admin' has every capability.
-- ============================================================

CREATE TABLE IF NOT EXISTS role_permissions (
  role        TEXT NOT NULL,
  capability  TEXT NOT NULL,
  allowed     BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role, capability)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role);

CREATE TABLE IF NOT EXISTS user_permission_overrides (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability  TEXT NOT NULL,
  granted     BOOLEAN NOT NULL,            -- true = grant extra, false = revoke
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES users(id),
  PRIMARY KEY (user_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_user_perm_overrides_user ON user_permission_overrides(user_id);

-- ------------------------------------------------------------
-- Seed defaults from the existing static matrix.
-- (Idempotent: ON CONFLICT DO NOTHING so re-running this migration
--  on an already-seeded DB does not overwrite admin edits.)
-- ------------------------------------------------------------
INSERT INTO role_permissions (role, capability, allowed) VALUES
  -- admin: everything
  ('admin', 'orders:view', true),
  ('admin', 'orders:edit', true),
  ('admin', 'orders:delete', true),
  ('admin', 'orders:review', true),
  ('admin', 'orders:approve', true),
  ('admin', 'invoices:view', true),
  ('admin', 'invoices:edit', true),
  ('admin', 'invoices:delete', true),
  ('admin', 'invoices:review', true),
  ('admin', 'invoices:approve', true),
  ('admin', 'admin:manage_users', true),
  ('admin', 'admin:manage_permissions', true),

  -- manager
  ('manager', 'orders:view', true),
  ('manager', 'orders:edit', true),
  ('manager', 'orders:review', true),
  ('manager', 'orders:approve', true),
  ('manager', 'invoices:view', true),
  ('manager', 'invoices:edit', true),
  ('manager', 'invoices:review', true),
  ('manager', 'invoices:approve', true),

  -- validator
  ('validator', 'orders:view', true),
  ('validator', 'orders:edit', true),
  ('validator', 'orders:review', true),
  ('validator', 'invoices:view', true),
  ('validator', 'invoices:edit', true),
  ('validator', 'invoices:review', true),

  -- user (read-only)
  ('user', 'orders:view', true),
  ('user', 'invoices:view', true)
ON CONFLICT (role, capability) DO NOTHING;

-- ------------------------------------------------------------
-- Helper view: effective permissions per user.
-- Useful for admin UI and ad-hoc queries.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW v_user_effective_permissions AS
SELECT
  u.id            AS user_id,
  u.email,
  u.full_name,
  u.role,
  c.capability,
  COALESCE(o.granted, rp.allowed, false) AS effective,
  rp.allowed       AS role_default,
  o.granted        AS override
FROM users u
CROSS JOIN (
  SELECT DISTINCT capability FROM role_permissions
) c
LEFT JOIN role_permissions rp
  ON rp.role = u.role AND rp.capability = c.capability
LEFT JOIN user_permission_overrides o
  ON o.user_id = u.id AND o.capability = c.capability;

COMMENT ON TABLE role_permissions IS 'Admin-editable role -> capability matrix.';
COMMENT ON TABLE user_permission_overrides IS 'Per-user grants/revokes that override the role default.';
COMMENT ON VIEW v_user_effective_permissions IS 'Resolved effective permission per (user, capability).';
