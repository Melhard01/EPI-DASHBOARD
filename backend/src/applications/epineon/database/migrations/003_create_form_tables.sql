-- Epineon: ONE DEDICATED TABLE PER FORM.
--   epineon.demo_submissions
--   epineon.sales_submissions
--   epineon.partnerships_submissions
--
-- ADDITIVE: creates new tables and copies any rows from the old shared table
-- (epineon.form_submissions), keeping their IDs and timestamps. The old table
-- is NOT deleted: it is frozen (inserts are rejected) and kept as a record.
-- The whole migration is one transaction and aborts if any old row cannot be
-- carried over, so nothing can be silently lost.
--
-- Columns every table has: id, status, is_read, read_at/read_by,
-- status_changed_at/status_changed_by, created_at, updated_at.
-- Field limits and option lists mirror the live Epineon contact page.

-- ------------------------------------------------------------------ demo
CREATE TABLE IF NOT EXISTS epineon.demo_submissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  email        text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254
                                    AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  company      text NOT NULL CHECK (char_length(company) BETWEEN 1 AND 160),
  role         text CHECK (role IS NULL OR char_length(role) BETWEEN 1 AND 120),
  product      text NOT NULL CHECK (product IN ('EPICRYPT', 'EPIQUANTUM', 'EPIWELL', 'EPI LeGallet',
                                                'Epitrust', 'SoulChain', 'Multiple products', 'Not sure yet')),
  message      text CHECK (message IS NULL OR char_length(message) BETWEEN 1 AND 5000),
  status       text NOT NULL DEFAULT 'new'
               CHECK (status IN ('new', 'in_progress', 'replied', 'closed', 'archived')),
  is_read      boolean NOT NULL DEFAULT false,
  read_at      timestamptz,
  read_by      uuid,
  status_changed_at timestamptz,
  status_changed_by uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demo_submissions_read_consistency
    CHECK (is_read = (read_at IS NOT NULL) AND (read_at IS NULL) = (read_by IS NULL))
);

-- ----------------------------------------------------------------- sales
CREATE TABLE IF NOT EXISTS epineon.sales_submissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  email        text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254
                                    AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  company      text NOT NULL CHECK (char_length(company) BETWEEN 1 AND 160),
  role         text CHECK (role IS NULL OR char_length(role) BETWEEN 1 AND 120),
  product      text NOT NULL CHECK (product IN ('EPICRYPT', 'EPIQUANTUM', 'EPIWELL', 'EPI LeGallet',
                                                'Epitrust', 'SoulChain', 'Multiple products', 'Not sure yet')),
  use_case     text NOT NULL CHECK (use_case IN ('Enterprise AI security', 'Health & wellness',
                                                 'Future intelligence / upskilling', 'Multiple ecosystems', 'Other')),
  message      text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 5000),
  status       text NOT NULL DEFAULT 'new'
               CHECK (status IN ('new', 'in_progress', 'replied', 'closed', 'archived')),
  is_read      boolean NOT NULL DEFAULT false,
  read_at      timestamptz,
  read_by      uuid,
  status_changed_at timestamptz,
  status_changed_by uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_submissions_read_consistency
    CHECK (is_read = (read_at IS NOT NULL) AND (read_at IS NULL) = (read_by IS NULL))
);

-- --------------------------------------------------------- partnerships
CREATE TABLE IF NOT EXISTS epineon.partnerships_submissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  email        text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254
                                    AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  organization text NOT NULL CHECK (char_length(organization) BETWEEN 1 AND 160),
  nature       text NOT NULL CHECK (char_length(nature) BETWEEN 1 AND 5000),
  status       text NOT NULL DEFAULT 'new'
               CHECK (status IN ('new', 'in_progress', 'replied', 'closed', 'archived')),
  is_read      boolean NOT NULL DEFAULT false,
  read_at      timestamptz,
  read_by      uuid,
  status_changed_at timestamptz,
  status_changed_by uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partnerships_submissions_read_consistency
    CHECK (is_read = (read_at IS NOT NULL) AND (read_at IS NULL) = (read_by IS NULL))
);

-- ------------------------------------------- indexes and updated_at trigger
CREATE INDEX IF NOT EXISTS demo_submissions_created_at_idx        ON epineon.demo_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS demo_submissions_status_idx            ON epineon.demo_submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS demo_submissions_unread_idx            ON epineon.demo_submissions (created_at DESC) WHERE NOT is_read;
CREATE INDEX IF NOT EXISTS sales_submissions_created_at_idx       ON epineon.sales_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS sales_submissions_status_idx           ON epineon.sales_submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS sales_submissions_unread_idx           ON epineon.sales_submissions (created_at DESC) WHERE NOT is_read;
CREATE INDEX IF NOT EXISTS partnerships_submissions_created_at_idx ON epineon.partnerships_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS partnerships_submissions_status_idx    ON epineon.partnerships_submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS partnerships_submissions_unread_idx    ON epineon.partnerships_submissions (created_at DESC) WHERE NOT is_read;

CREATE OR REPLACE TRIGGER demo_submissions_set_updated_at
  BEFORE UPDATE ON epineon.demo_submissions
  FOR EACH ROW EXECUTE FUNCTION epineon.set_updated_at();
CREATE OR REPLACE TRIGGER sales_submissions_set_updated_at
  BEFORE UPDATE ON epineon.sales_submissions
  FOR EACH ROW EXECUTE FUNCTION epineon.set_updated_at();
CREATE OR REPLACE TRIGGER partnerships_submissions_set_updated_at
  BEFORE UPDATE ON epineon.partnerships_submissions
  FOR EACH ROW EXECUTE FUNCTION epineon.set_updated_at();

-- ------------------------------ copy existing rows from the old shared table
INSERT INTO epineon.demo_submissions
  (id, name, email, company, role, product, message, status, is_read, read_at, read_by,
   status_changed_at, status_changed_by, created_at, updated_at)
SELECT submission_id, data->>'name', data->>'email', data->>'company', data->>'role', data->>'product',
       data->>'message', status, read_at IS NOT NULL, read_at, read_by,
       status_changed_at, status_changed_by, received_at, updated_at
FROM epineon.form_submissions WHERE form_type = 'demo'
ON CONFLICT (id) DO NOTHING;

INSERT INTO epineon.sales_submissions
  (id, name, email, company, role, product, use_case, message, status, is_read, read_at, read_by,
   status_changed_at, status_changed_by, created_at, updated_at)
SELECT submission_id, data->>'name', data->>'email', data->>'company', data->>'role', data->>'product',
       data->>'useCase', data->>'message', status, read_at IS NOT NULL, read_at, read_by,
       status_changed_at, status_changed_by, received_at, updated_at
FROM epineon.form_submissions WHERE form_type = 'sales'
ON CONFLICT (id) DO NOTHING;

INSERT INTO epineon.partnerships_submissions
  (id, name, email, organization, nature, status, is_read, read_at, read_by,
   status_changed_at, status_changed_by, created_at, updated_at)
SELECT submission_id, data->>'name', data->>'email', data->>'organization', data->>'nature',
       status, read_at IS NOT NULL, read_at, read_by,
       status_changed_at, status_changed_by, received_at, updated_at
FROM epineon.form_submissions WHERE form_type = 'partnerships'
ON CONFLICT (id) DO NOTHING;

-- Abort (rolling everything back) unless every old row now exists in its form's table.
DO $$
DECLARE
  old_total  integer;
  old_known  integer;
  new_copied integer;
BEGIN
  SELECT count(*) INTO old_total FROM epineon.form_submissions;
  SELECT count(*) INTO old_known FROM epineon.form_submissions
    WHERE form_type IN ('demo', 'sales', 'partnerships');
  SELECT (SELECT count(*) FROM epineon.demo_submissions d JOIN epineon.form_submissions o
            ON o.submission_id = d.id AND o.form_type = 'demo')
       + (SELECT count(*) FROM epineon.sales_submissions s JOIN epineon.form_submissions o
            ON o.submission_id = s.id AND o.form_type = 'sales')
       + (SELECT count(*) FROM epineon.partnerships_submissions p JOIN epineon.form_submissions o
            ON o.submission_id = p.id AND o.form_type = 'partnerships')
    INTO new_copied;
  IF old_total <> old_known THEN
    RAISE EXCEPTION 'epineon.form_submissions contains rows with an unknown form_type (% of % rows)',
      old_total - old_known, old_total;
  END IF;
  IF new_copied <> old_total THEN
    RAISE EXCEPTION 'epineon migration copied % of % existing submissions', new_copied, old_total;
  END IF;
END
$$;

-- ----------------------------------------------- freeze the old shared table
CREATE OR REPLACE FUNCTION epineon.reject_legacy_submission_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'epineon.form_submissions is frozen: each form has its own table (demo_submissions, sales_submissions, partnerships_submissions)'
    USING ERRCODE = 'feature_not_supported';
END
$$;

CREATE OR REPLACE TRIGGER form_submissions_frozen
  BEFORE INSERT ON epineon.form_submissions
  FOR EACH ROW EXECUTE FUNCTION epineon.reject_legacy_submission_insert();

COMMENT ON TABLE epineon.form_submissions IS
  'DEPRECATED and frozen (inserts rejected). Replaced by one table per form. Kept as a record; may be dropped after review.';
