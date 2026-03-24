-- CreateEnum
CREATE TYPE "AdminUserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "UserModeration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AdminUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserModeration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserModeration_userId_key" ON "UserModeration"("userId");

-- CreateIndex
CREATE INDEX "UserModeration_status_idx" ON "UserModeration"("status");

-- AddForeignKey
ALTER TABLE "UserModeration" ADD CONSTRAINT "UserModeration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
