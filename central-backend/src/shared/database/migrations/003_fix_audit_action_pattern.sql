-- Fix: audit action names may contain underscores in their first segment
-- (e.g. "admin_user.created"). Migration 002 only allowed letters there, which
-- would have rejected every admin-user audit entry.
--
-- Only a CHECK constraint changes. No rows are touched (the table is
-- append-only and DML triggers do not run for ALTER TABLE), and the new
-- pattern is a strict superset of the old one, so every existing row is valid.
ALTER TABLE platform_admin.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE platform_admin.audit_log
  ADD CONSTRAINT audit_log_action_check
  CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$');
