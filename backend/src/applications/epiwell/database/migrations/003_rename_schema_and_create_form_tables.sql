-- Epi Well: schema renamed to "epiwell" and ONE DEDICATED TABLE PER FORM.
--   epiwell.waitlist_submissions
--
-- ADDITIVE / NON-DESTRUCTIVE:
--  1. Renames the schema epi_well -> epiwell (a metadata-only change: the old
--     shared table, its rows, indexes and functions all move with it).
--  2. Creates the waitlist table and copies any existing waitlist rows
--     (keeping IDs and timestamps).
--  3. Freezes the old shared table (inserts rejected); it is not deleted.
-- One transaction; aborts if any old row cannot be carried over.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'epi_well')
     AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'epiwell') THEN
    ALTER SCHEMA epi_well RENAME TO epiwell;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS epiwell;

CREATE TABLE IF NOT EXISTS epiwell.waitlist_submissions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254
                                  AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  status     text NOT NULL DEFAULT 'new'
             CHECK (status IN ('new', 'in_progress', 'replied', 'closed', 'archived')),
  is_read    boolean NOT NULL DEFAULT false,
  read_at    timestamptz,
  read_by    uuid,
  status_changed_at timestamptz,
  status_changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waitlist_submissions_read_consistency
    CHECK (is_read = (read_at IS NOT NULL) AND (read_at IS NULL) = (read_by IS NULL))
);

-- One waitlist entry per email address (case-insensitive), as on the live site.
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_submissions_email_key
  ON epiwell.waitlist_submissions (lower(email));
CREATE INDEX IF NOT EXISTS waitlist_submissions_created_at_idx
  ON epiwell.waitlist_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS waitlist_submissions_status_idx
  ON epiwell.waitlist_submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS waitlist_submissions_unread_idx
  ON epiwell.waitlist_submissions (created_at DESC) WHERE NOT is_read;

CREATE OR REPLACE TRIGGER waitlist_submissions_set_updated_at
  BEFORE UPDATE ON epiwell.waitlist_submissions
  FOR EACH ROW EXECUTE FUNCTION epiwell.set_updated_at();

-- ------------------------------ copy existing rows from the old shared table
INSERT INTO epiwell.waitlist_submissions
  (id, email, status, is_read, read_at, read_by, status_changed_at, status_changed_by, created_at, updated_at)
SELECT submission_id, data->>'email', status, read_at IS NOT NULL, read_at, read_by,
       status_changed_at, status_changed_by, received_at, updated_at
FROM epiwell.form_submissions WHERE form_type = 'waitlist'
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  old_total  integer;
  new_copied integer;
BEGIN
  SELECT count(*) INTO old_total FROM epiwell.form_submissions;
  SELECT count(*) INTO new_copied
    FROM epiwell.waitlist_submissions n
    JOIN epiwell.form_submissions o ON o.submission_id = n.id AND o.form_type = 'waitlist';
  IF new_copied <> old_total THEN
    RAISE EXCEPTION 'epiwell migration copied % of % existing submissions (unknown form types or unmappable rows)',
      new_copied, old_total;
  END IF;
END
$$;

-- ----------------------------------------------- freeze the old shared table
CREATE OR REPLACE FUNCTION epiwell.reject_legacy_submission_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'epiwell.form_submissions is frozen: each form has its own table (waitlist_submissions)'
    USING ERRCODE = 'feature_not_supported';
END
$$;

CREATE OR REPLACE TRIGGER form_submissions_frozen
  BEFORE INSERT ON epiwell.form_submissions
  FOR EACH ROW EXECUTE FUNCTION epiwell.reject_legacy_submission_insert();

COMMENT ON TABLE epiwell.form_submissions IS
  'DEPRECATED and frozen (inserts rejected). Replaced by one table per form. Kept as a record; may be dropped after review.';
