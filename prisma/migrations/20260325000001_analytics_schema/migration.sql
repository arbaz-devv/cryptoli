-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'MODERATOR';
ALTER TYPE "Role" ADD VALUE 'ADMIN';
ALTER TYPE "Role" ADD VALUE 'VERIFIED_EXPERT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ACCOUNT_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'PROFILE_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'REVIEW_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'REVIEW_LIKED';
ALTER TYPE "NotificationType" ADD VALUE 'COMMENT_ADDED';

-- DropIndex
DROP INDEX "PushSubscription_userId_idx";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "registration_country" CHAR(2),
ADD COLUMN     "registration_ip" VARCHAR(45);

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "browser" VARCHAR(64),
ADD COLUMN     "country" CHAR(2),
ADD COLUMN     "device" VARCHAR(16),
ADD COLUMN     "ip" VARCHAR(45),
ADD COLUMN     "ipHash" CHAR(64),
ADD COLUMN     "os" VARCHAR(64),
ADD COLUMN     "timezone" VARCHAR(64),
ADD COLUMN     "trigger" VARCHAR(20),
ADD COLUMN     "userAgent" VARCHAR(512);

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "data" JSONB,
ADD COLUMN     "pushedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PushSubscription" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "userAgent" TEXT;

-- CreateTable
CREATE TABLE "analytics_events" (
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

-- CreateTable
CREATE TABLE "analytics_daily_summaries" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "dimension" TEXT NOT NULL,
    "dimension_value" VARCHAR(128) NOT NULL,
    "count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_daily_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analytics_events_user_id_idx" ON "analytics_events"("user_id");

-- CreateIndex
CREATE INDEX "analytics_events_event_type_created_at_idx" ON "analytics_events"("event_type", "created_at");

-- CreateIndex
CREATE INDEX "analytics_events_created_at_idx" ON "analytics_events"("created_at");

-- CreateIndex
CREATE INDEX "analytics_daily_summaries_date_idx" ON "analytics_daily_summaries"("date");

-- CreateIndex
CREATE INDEX "analytics_daily_summaries_dimension_date_idx" ON "analytics_daily_summaries"("dimension", "date");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_daily_summaries_date_dimension_dimension_value_key" ON "analytics_daily_summaries"("date", "dimension", "dimension_value");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_createdAt_idx" ON "Session"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_read_createdAt_idx" ON "Notification"("userId", "read", "createdAt");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_createdAt_idx" ON "PushSubscription"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

