-- DropIndex
DROP INDEX "AutomationRun_workspaceId_idx";

-- DropIndex
DROP INDEX "AutomationRun_workspaceId_firedAt_idx";

-- DropIndex
DROP INDEX "AutomationRun_workspaceId_eventType_idx";

-- DropIndex
DROP INDEX "AutomationRun_workspaceId_status_idx";

-- AlterTable
ALTER TABLE "AutomationRun" DROP COLUMN "workspaceId";

-- CreateIndex
CREATE INDEX "AutomationRun_firedAt_idx" ON "AutomationRun"("firedAt" DESC);

-- CreateIndex
CREATE INDEX "AutomationRun_eventType_idx" ON "AutomationRun"("eventType");

-- CreateIndex
CREATE INDEX "AutomationRun_status_idx" ON "AutomationRun"("status");
