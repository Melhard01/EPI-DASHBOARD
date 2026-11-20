-- Epi Well: submission workflow for the admin dashboard.
-- ADDITIVE ONLY: adds columns (with defaults), a trigger and indexes.
-- No column is dropped or retyped and no existing value is rewritten.
--   status            new | in_progress | replied | closed | archived
--   read_at / read_by read tracking, separate from status
--   status_changed_*  who changed the status last, and when
--   updated_at        maintained by trigger on every update
-- read_by / status_changed_by hold platform admin user IDs (no FK: admin
-- identity lives outside this application's schema).

ALTER TABLE epi_well.form_submissions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new'
    CONSTRAINT form_submissions_status_check
    CHECK (status IN ('new', 'in_progress', 'replied', 'closed', 'archived')),
  ADD COLUMN IF NOT EXISTS updated_at        timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS read_at           timestamptz,
  ADD COLUMN IF NOT EXISTS read_by           uuid,
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_changed_by uuid;

ALTER TABLE epi_well.form_submissions
  ADD CONSTRAINT form_submissions_read_consistency_check
    CHECK ((read_at IS NULL) = (read_by IS NULL));

CREATE OR REPLACE FUNCTION epi_well.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER form_submissions_set_updated_at
  BEFORE UPDATE ON epi_well.form_submissions
  FOR EACH ROW EXECUTE FUNCTION epi_well.set_updated_at();

CREATE INDEX IF NOT EXISTS form_submissions_status_received_at_idx
  ON epi_well.form_submissions (status, received_at DESC);

CREATE INDEX IF NOT EXISTS form_submissions_received_at_idx
  ON epi_well.form_submissions (received_at DESC);

CREATE INDEX IF NOT EXISTS form_submissions_unread_idx
  ON epi_well.form_submissions (received_at DESC)
  WHERE read_at IS NULL;

-- Waitlist: one entry per email address (case-insensitive), as on the live
-- site. Enforced by the database so concurrent sign-ups cannot duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS form_submissions_waitlist_email_key
  ON epi_well.form_submissions (lower(data->>'email'))
  WHERE form_type = 'waitlist';
