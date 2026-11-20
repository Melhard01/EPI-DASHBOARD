-- Epi Well: form submissions.
-- Lives in Epi Well's own schema; no other application reads or writes it.
CREATE SCHEMA IF NOT EXISTS epi_well;

CREATE TABLE IF NOT EXISTS epi_well.form_submissions (
  submission_id uuid        PRIMARY KEY,
  application   text        NOT NULL CHECK (application = 'epi-well'),
  form_type     text        NOT NULL CHECK (form_type ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  data          jsonb       NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  received_at   timestamptz NOT NULL,
  stored_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS form_submissions_form_type_received_at_idx
  ON epi_well.form_submissions (form_type, received_at DESC);
