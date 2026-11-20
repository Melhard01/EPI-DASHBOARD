-- QAegis: ONE DEDICATED TABLE PER FORM.
--   qaegis.contact_sales_submissions
--
-- ADDITIVE: creates the new table and copies any rows from the old shared
-- table (qaegis.form_submissions), keeping their IDs and timestamps. The old
-- table is NOT deleted: it is frozen (inserts are rejected) and kept as a
-- record. One transaction; aborts if any old row cannot be carried over.
-- Field limits and options mirror the live QAegis "Request Enterprise Access" form.

CREATE TABLE IF NOT EXISTS qaegis.contact_sales_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name      text NOT NULL CHECK (char_length(first_name) BETWEEN 1 AND 120),
  last_name       text NOT NULL CHECK (char_length(last_name) BETWEEN 1 AND 120),
  work_email      text NOT NULL CHECK (char_length(work_email) BETWEEN 3 AND 254
                                       AND work_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  company_website text CHECK (company_website IS NULL OR char_length(company_website) BETWEEN 1 AND 500),
  user_range      text NOT NULL CHECK (user_range IN ('1-50', '51-250', '251-1000', '1000+')),
  message         text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 10000),
  status          text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'in_progress', 'replied', 'closed', 'archived')),
  is_read         boolean NOT NULL DEFAULT false,
  read_at         timestamptz,
  read_by         uuid,
  status_changed_at timestamptz,
  status_changed_by uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_sales_submissions_read_consistency
    CHECK (is_read = (read_at IS NOT NULL) AND (read_at IS NULL) = (read_by IS NULL))
);

CREATE INDEX IF NOT EXISTS contact_sales_submissions_created_at_idx
  ON qaegis.contact_sales_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS contact_sales_submissions_status_idx
  ON qaegis.contact_sales_submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS contact_sales_submissions_unread_idx
  ON qaegis.contact_sales_submissions (created_at DESC) WHERE NOT is_read;

CREATE OR REPLACE TRIGGER contact_sales_submissions_set_updated_at
  BEFORE UPDATE ON qaegis.contact_sales_submissions
  FOR EACH ROW EXECUTE FUNCTION qaegis.set_updated_at();

-- ------------------------------ copy existing rows from the old shared table
INSERT INTO qaegis.contact_sales_submissions
  (id, first_name, last_name, work_email, company_website, user_range, message, status, is_read,
   read_at, read_by, status_changed_at, status_changed_by, created_at, updated_at)
SELECT submission_id, data->>'firstName', data->>'lastName', data->>'workEmail', data->>'companyWebsite',
       data->>'userRange', data->>'message', status, read_at IS NOT NULL, read_at, read_by,
       status_changed_at, status_changed_by, received_at, updated_at
FROM qaegis.form_submissions WHERE form_type = 'contact-sales'
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  old_total  integer;
  new_copied integer;
BEGIN
  SELECT count(*) INTO old_total FROM qaegis.form_submissions;
  SELECT count(*) INTO new_copied
    FROM qaegis.contact_sales_submissions n
    JOIN qaegis.form_submissions o ON o.submission_id = n.id AND o.form_type = 'contact-sales';
  IF new_copied <> old_total THEN
    RAISE EXCEPTION 'qaegis migration copied % of % existing submissions (unknown form types or unmappable rows)',
      new_copied, old_total;
  END IF;
END
$$;

-- ----------------------------------------------- freeze the old shared table
CREATE OR REPLACE FUNCTION qaegis.reject_legacy_submission_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'qaegis.form_submissions is frozen: each form has its own table (contact_sales_submissions)'
    USING ERRCODE = 'feature_not_supported';
END
$$;

CREATE OR REPLACE TRIGGER form_submissions_frozen
  BEFORE INSERT ON qaegis.form_submissions
  FOR EACH ROW EXECUTE FUNCTION qaegis.reject_legacy_submission_insert();

COMMENT ON TABLE qaegis.form_submissions IS
  'DEPRECATED and frozen (inserts rejected). Replaced by one table per form. Kept as a record; may be dropped after review.';
