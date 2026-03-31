CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS company_name_trgm_idx
ON "Company" USING GIN (lower(name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS company_description_trgm_idx
ON "Company" USING GIN (lower(COALESCE(description, '')) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS review_title_trgm_idx
ON "Review" USING GIN (lower(title) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS review_content_trgm_idx
ON "Review" USING GIN (lower(content) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS user_username_trgm_idx
ON "User" USING GIN (lower(username) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS user_name_trgm_idx
ON "User" USING GIN (lower(COALESCE(name, '')) gin_trgm_ops);
