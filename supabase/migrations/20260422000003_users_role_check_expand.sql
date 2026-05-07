-- ============================================================
-- Expand users.role CHECK constraint to allow new RBAC roles
-- (admin, manager, validator, user) while preserving legacy
-- aliases (reviewer, read_only) for backward compatibility.
-- ============================================================

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'manager', 'validator', 'user', 'reviewer', 'read_only'));

-- Optional: normalize the column default to 'user' (the new canonical
-- equivalent of 'read_only'). Existing rows are not touched.
ALTER TABLE users
  ALTER COLUMN role SET DEFAULT 'user';
