-- Platform: consolidate platform tables in platform_admin.
--
-- 1. rate_limit_counters moves from platform_security to platform_admin
--    (ALTER TABLE ... SET SCHEMA: a metadata-only move. Rows, indexes and
--    constraints go with it. The now-empty platform_security schema is left in
--    place; it can be dropped later after review.)
-- 2. audit_log gains form_type, so entries identify the exact form (tables are
--    now per form). Additive; the append-only triggers are unaffected.
-- 3. Admin access rows granted under the old Epi Well slug are re-pointed to
--    the new slug (a pure key rename; there are no such rows today).

DO $$
BEGIN
  IF to_regclass('platform_security.rate_limit_counters') IS NOT NULL
     AND to_regclass('platform_admin.rate_limit_counters') IS NULL THEN
    ALTER TABLE platform_security.rate_limit_counters SET SCHEMA platform_admin;
  END IF;
END
$$;

ALTER TABLE platform_admin.audit_log
  ADD COLUMN IF NOT EXISTS form_type text
  CHECK (form_type IS NULL OR form_type ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

UPDATE platform_admin.admin_app_access old
   SET application = 'epiwell'
 WHERE old.application = 'epi-well'
   AND NOT EXISTS (
     SELECT 1 FROM platform_admin.admin_app_access n
      WHERE n.user_id = old.user_id AND n.application = 'epiwell');
