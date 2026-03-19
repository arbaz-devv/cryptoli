-- Clear all existing sessions: raw JWTs will never match hashed lookups.
-- All users will need to log in again after this migration.
DELETE FROM "Session";
