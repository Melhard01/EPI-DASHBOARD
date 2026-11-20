-- Platform security infrastructure: rate-limit counters.
-- Shared by all applications but kept in its own schema, separate from every
-- application's submission schema. Rows contain no personal data: the client
-- is identified only by an HMAC (64 hex chars) of its network address.
CREATE SCHEMA IF NOT EXISTS platform_security;

CREATE TABLE IF NOT EXISTS platform_security.rate_limit_counters (
  scope          text        NOT NULL CHECK (scope ~ '^[a-z0-9-]+:[a-z0-9-]+$'),
  client_key     text        NOT NULL CHECK (client_key ~ '^[0-9a-f]{64}$'),
  window_seconds integer     NOT NULL CHECK (window_seconds > 0),
  window_start   timestamptz NOT NULL,
  hits           integer     NOT NULL CHECK (hits > 0),
  expires_at     timestamptz NOT NULL,
  PRIMARY KEY (scope, client_key, window_seconds, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limit_counters_expires_at_idx
  ON platform_security.rate_limit_counters (expires_at);
