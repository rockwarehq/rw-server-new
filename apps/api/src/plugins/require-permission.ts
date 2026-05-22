import type { FastifyReply, FastifyRequest } from "fastify";
import type { Permission } from "@rw/services/iam/index";
import { hasPermission } from "@rw/services/iam/index";

/**
 * Fastify preHandler that enforces a single RBAC permission.
 *
 * Usage — implicit workspace from the auth token:
 *   preHandler: [fastify.verifyAccessToken, requirePermission("user:read")]
 *
 * Usage — route URL carries `:workspaceId` or another param name:
 *   preHandler: [fastify.verifyAccessToken, requirePermission("settings:write", { workspaceParam: "id" })]
 *
 * Usage — workspace-level check that must ignore token site context:
 *   preHandler: [fastify.verifyAccessToken, requirePermission("user:read", { scope: "workspace" })]
 *
 * Returns:
 *   - 401 if the request is unauthenticated or has no workspace context.
 *   - 403 `{ error: "forbidden", required }` if the check fails.
 */
export interface RequirePermissionOptions {
  /**
   * Permission context scope. Default preserves legacy behavior by including
   * route/token site context when present. Use "workspace" for workspace-level
   * actions like user administration where site-scoped roles must not apply.
   */
  scope?: "workspace" | "site";
  /**
   * Route-param name that holds the workspace id. Default: none (use the
   * workspace id attached to the auth token via `request.iam.workspaceId`).
   *
   * Supply this for routes like `POST /workspaces/:id/members` where the
   * workspace being acted on is in the URL, not the caller's session.
   */
  workspaceParam?: string;
  /**
   * Route-param name that holds the site id, for site-scoped checks.
   * Default: `"siteId"` when present. Set `scope: "workspace"` if you don't
   * want site scope to influence the check.
   */
  siteParam?: string;
}

export function requirePermission(permission: Permission, opts: RequirePermissionOptions = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.iam?.id;
    if (!userId) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const params = req.params as Record<string, string | undefined> | undefined;
    const workspaceId = opts.workspaceParam ? params?.[opts.workspaceParam] : req.iam?.workspaceId;

    if (!workspaceId) {
      return reply.status(401).send({ error: "No workspace context" });
    }

    const siteKey = opts.siteParam ?? "siteId";
    const siteId = opts.scope === "workspace" ? undefined : (params?.[siteKey] ?? req.iam?.siteId);

    if (opts.scope === "site" && !siteId) {
      return reply.status(401).send({ error: "No site context" });
    }

    const ok = await hasPermission(userId, permission, { workspaceId, siteId });
    if (!ok) {
      return reply.status(403).send({ error: "forbidden", required: permission });
    }
  };
}
