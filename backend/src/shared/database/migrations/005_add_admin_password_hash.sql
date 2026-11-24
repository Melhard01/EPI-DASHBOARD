-- Add password_hash column to admin_users for JWT-based email/password authentication.
-- Made nullable to preserve existing admin accounts during migration.
-- Existing admins must set their password via the admin panel or CLI before they can login.

ALTER TABLE platform_admin.admin_users
ADD COLUMN password_hash text;

-- Index for faster lookups during login (email is already unique, used for queries)
-- password_hash does not need an index (not used in WHERE clauses)
