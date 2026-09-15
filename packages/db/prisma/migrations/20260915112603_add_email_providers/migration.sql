-- CreateEnum
CREATE TYPE "EmailProviderType" AS ENUM ('SES', 'BREVO');

-- CreateTable
CREATE TABLE "project_email_providers" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" "EmailProviderType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "apiKey" TEXT,
    "dailyQuota" INTEGER,
    "monthlyQuota" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_email_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_quota_usage" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "provider_quota_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_email_providers_projectId_enabled_priority_idx" ON "project_email_providers"("projectId", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "project_email_providers_projectId_provider_key" ON "project_email_providers"("projectId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "provider_quota_usage_providerId_date_key" ON "provider_quota_usage"("providerId", "date");

-- AddForeignKey
ALTER TABLE "project_email_providers" ADD CONSTRAINT "project_email_providers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_quota_usage" ADD CONSTRAINT "provider_quota_usage_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "project_email_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
