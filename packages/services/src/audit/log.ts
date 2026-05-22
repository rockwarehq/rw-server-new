import prisma from "@rw/db";
import type { AuditAction } from "@rw/db";

export interface LogEventParams {
  action: AuditAction;
  userId?: string;
  actorId?: string;
  workspaceId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log a security-relevant event to the audit trail.
 * This function is designed to never throw - audit logging should not break the main flow.
 */
export async function logEvent(params: LogEventParams): Promise<void> {
  const { action, userId, actorId, workspaceId, ipAddress, userAgent, metadata } = params;

  try {
    await prisma.auditLog.create({
      data: {
        action,
        userId,
        actorId,
        workspaceId,
        ipAddress,
        userAgent,
        metadata: metadata ?? undefined,
      },
    });
  } catch (error) {
    // Audit logging should never break the main flow
    console.error("[AUDIT] Failed to log event:", {
      action,
      userId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Convenience function for request context
 */
export function extractRequestContext(request: { ip?: string; headers?: { "user-agent"?: string } }): {
  ipAddress?: string;
  userAgent?: string;
} {
  return {
    ipAddress: request.ip,
    userAgent: request.headers?.["user-agent"],
  };
}
