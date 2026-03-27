-- Idempotent migration: works on fresh DBs (migrations only) and db-pushed DBs.
-- Requires PostgreSQL >= 12 (for ADD VALUE IF NOT EXISTS in transactions).

-- AlterEnum (idempotent)
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MODERATOR';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ADMIN';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'VERIFIED_EXPERT';

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ACCOUNT_CREATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PROFILE_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_CREATED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'REVIEW_LIKED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'COMMENT_ADDED';

-- CreateTable: PushSubscription
-- This table was missing from the baseline migration (created only via db push).
-- On fresh DBs this creates it; on db-pushed DBs IF NOT EXISTS skips it.
CREATE TABLE IF NOT EXISTS "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- DropIndex (idempotent — may not exist on fresh DBs or already dropped on pushed DBs)
DROP INDEX IF EXISTS "PushSubscription_userId_idx";

-- AlterTable: User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "registration_country" CHAR(2);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "registration_ip" VARCHAR(45);

-- AlterTable: Session
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "browser" VARCHAR(64);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "country" CHAR(2);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "device" VARCHAR(16);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "ip" VARCHAR(45);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "ipHash" CHAR(64);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "os" VARCHAR(64);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "timezone" VARCHAR(64);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "trigger" VARCHAR(20);
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "userAgent" VARCHAR(512);

-- AlterTable: Notification
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "actorId" TEXT;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "data" JSONB;
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "pushedAt" TIMESTAMP(3);

-- AlterTable: PushSubscription (columns may already exist from CREATE TABLE above or db push)
ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "userAgent" TEXT;

-- CreateTable: analytics_events
CREATE TABLE IF NOT EXISTS "analytics_events" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "session_id" VARCHAR(128),
    "user_id" TEXT,
    "ip_hash" CHAR(64),
    "country" CHAR(2),
    "device" VARCHAR(16),
    "browser" VARCHAR(64),
    "os" VARCHAR(64),
    "timezone" VARCHAR(64),
    "path" VARCHAR(512),
    "referrer" VARCHAR(128),
    "utm_source" VARCHAR(80),
    "utm_medium" VARCHAR(80),
    "utm_campaign" VARCHAR(80),
    "duration_seconds" INTEGER,
    "properties" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable: analytics_daily_summaries
CREATE TABLE IF NOT EXISTS "analytics_daily_summaries" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "dimension" TEXT NOT NULL,
    "dimension_value" VARCHAR(128) NOT NULL,
    "count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_daily_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (all idempotent)
CREATE INDEX IF NOT EXISTS "analytics_events_user_id_idx" ON "analytics_events"("user_id");
CREATE INDEX IF NOT EXISTS "analytics_events_event_type_created_at_idx" ON "analytics_events"("event_type", "created_at");
CREATE INDEX IF NOT EXISTS "analytics_events_created_at_idx" ON "analytics_events"("created_at");
CREATE INDEX IF NOT EXISTS "analytics_daily_summaries_date_idx" ON "analytics_daily_summaries"("date");
CREATE INDEX IF NOT EXISTS "analytics_daily_summaries_dimension_date_idx" ON "analytics_daily_summaries"("dimension", "date");
CREATE UNIQUE INDEX IF NOT EXISTS "analytics_daily_summaries_date_dimension_dimension_value_key" ON "analytics_daily_summaries"("date", "dimension", "dimension_value");
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");
CREATE INDEX IF NOT EXISTS "Session_createdAt_idx" ON "Session"("createdAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "Notification_userId_read_createdAt_idx" ON "Notification"("userId", "read", "createdAt");
CREATE INDEX IF NOT EXISTS "PushSubscription_userId_createdAt_idx" ON "PushSubscription"("userId", "createdAt");

-- AddForeignKey: Notification.actorId (no IF NOT EXISTS for constraints — use DO $$ guard)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Notification_actorId_fkey') THEN
    ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey"
      FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey: PushSubscription.userId (missing from all migrations — was only created by db push)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PushSubscription_userId_fkey') THEN
    ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
