-- Platform admin identity, per-application access and the audit log.
-- Holds NO submission data. Application submission schemas are untouched.
--
-- Access levels:
--   Super Admin        admin_users.is_super_admin = true (all applications)
--   Application admin  one admin_app_access row per application
-- Authentication is done by Cloudflare Access; this schema only answers
-- "who is this verified email, and which applications may they manage?".

CREATE SCHEMA IF NOT EXISTS platform_admin;

CREATE OR REPLACE FUNCTION platform_admin.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TABLE IF NOT EXISTS platform_admin.admin_users (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text        NOT NULL
                 CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254
                        AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  display_name   text        CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 120),
  is_super_admin boolean     NOT NULL DEFAULT false,
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by     uuid        REFERENCES platform_admin.admin_users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_key
  ON platform_admin.admin_users (email);

CREATE OR REPLACE TRIGGER admin_users_set_updated_at
  BEFORE UPDATE ON platform_admin.admin_users
  FOR EACH ROW EXECUTE FUNCTION platform_admin.set_updated_at();

CREATE TABLE IF NOT EXISTS platform_admin.admin_app_access (
  user_id     uuid        NOT NULL REFERENCES platform_admin.admin_users (id) ON DELETE CASCADE,
  application text        NOT NULL CHECK (application ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  granted_by  uuid        REFERENCES platform_admin.admin_users (id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, application)
);

CREATE INDEX IF NOT EXISTS admin_app_access_application_idx
  ON platform_admin.admin_app_access (application);

-- Append-only audit trail of admin actions. Never contains submission
-- contents (names, emails, messages): only IDs, actions and status values.
CREATE TABLE IF NOT EXISTS platform_admin.audit_log (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  actor_id       uuid        NOT NULL,
  action         text        NOT NULL CHECK (action ~ '^[a-z]+(\.[a-z_]+)+$'),
  application    text        CHECK (application IS NULL OR application ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  submission_id  uuid,
  target_user_id uuid,
  details        jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX IF NOT EXISTS audit_log_at_idx ON platform_admin.audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_application_at_idx ON platform_admin.audit_log (application, at DESC);

CREATE OR REPLACE FUNCTION platform_admin.reject_audit_log_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'platform_admin.audit_log is append-only'
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE OR REPLACE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON platform_admin.audit_log
  FOR EACH ROW EXECUTE FUNCTION platform_admin.reject_audit_log_change();

CREATE OR REPLACE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON platform_admin.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION platform_admin.reject_audit_log_change();
