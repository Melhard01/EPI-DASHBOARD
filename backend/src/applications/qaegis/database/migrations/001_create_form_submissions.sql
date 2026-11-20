-- QAegis: form submissions.
-- Lives in QAegis's own schema; no other application reads or writes it.
CREATE SCHEMA IF NOT EXISTS qaegis;

CREATE TABLE IF NOT EXISTS qaegis.form_submissions (
  submission_id uuid        PRIMARY KEY,
  application   text        NOT NULL CHECK (application = 'qaegis'),
  form_type     text        NOT NULL CHECK (form_type ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  data          jsonb       NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  received_at   timestamptz NOT NULL,
  stored_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS form_submissions_form_type_received_at_idx
  ON qaegis.form_submissions (form_type, received_at DESC);
