-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "AutomationActionRunStatus" AS ENUM ('SUCCESS', 'FAILED', 'SKIPPED', 'SCHEDULED');

-- CreateTable
CREATE TABLE "Automation" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "event" TEXT NOT NULL,
    "eventVersion" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventVersion" TEXT NOT NULL,
    "eventId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "AutomationRunStatus" NOT NULL,
    "error" TEXT,
    "firedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationActionRun" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "actionIdx" INTEGER NOT NULL,
    "actionType" TEXT NOT NULL,
    "actionVersion" TEXT NOT NULL,
    "status" "AutomationActionRunStatus" NOT NULL,
    "error" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AutomationActionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRunMatch" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "matchIdx" INTEGER NOT NULL,

    CONSTRAINT "AutomationRunMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Automation_label_key" ON "Automation"("label");

-- CreateIndex
CREATE INDEX "Automation_enabled_event_idx" ON "Automation"("enabled", "event");

-- CreateIndex
CREATE INDEX "AutomationRun_firedAt_idx" ON "AutomationRun"("firedAt" DESC);

-- CreateIndex
CREATE INDEX "AutomationRun_eventType_idx" ON "AutomationRun"("eventType");

-- CreateIndex
CREATE INDEX "AutomationRun_status_idx" ON "AutomationRun"("status");

-- CreateIndex
CREATE INDEX "AutomationActionRun_runId_idx" ON "AutomationActionRun"("runId");

-- CreateIndex
CREATE INDEX "AutomationActionRun_automationId_idx" ON "AutomationActionRun"("automationId");

-- CreateIndex
CREATE INDEX "AutomationActionRun_actionType_idx" ON "AutomationActionRun"("actionType");

-- CreateIndex
CREATE INDEX "AutomationRunMatch_automationId_idx" ON "AutomationRunMatch"("automationId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRunMatch_runId_automationId_key" ON "AutomationRunMatch"("runId", "automationId");

-- AddForeignKey
ALTER TABLE "AutomationActionRun" ADD CONSTRAINT "AutomationActionRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRunMatch" ADD CONSTRAINT "AutomationRunMatch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
