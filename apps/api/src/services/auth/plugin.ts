import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import createError from "http-errors";
import { verifyAccessToken, type DecodedAccessToken } from "@rw/services/auth/tokens";
import { listAccessibleSites } from "@rw/services/iam/index";
import { Principal, type IAMContext, type UnknownIAMContext } from "@rw/services/auth/context";
import prisma from "@rw/db";

const AUTH_HEADER_PREFIX = "Bearer ";

interface LegacyDecodedUserAccessToken {
  id: string;
  email: string;
  workspaceId?: string;
  siteId?: string;
  iat: number;
  exp: number;
}

function isDisplayAccessToken(
  decodedToken: DecodedAccessToken,
): decodedToken is DecodedAccessToken & { principal: "DISPLAY" } {
  return decodedToken.principal === Principal.DISPLAY;
}

async function resolveDisplayIAM(displayId: string): Promise<IAMContext> {
  const iam: UnknownIAMContext = {
    principal: Principal.UNKNOWN,
    validToken: false,
  };

  const display = await prisma.display.findUnique({
    where: { id: displayId },
    select: {
      id: true,
      name: true,
      status: true,
      siteId: true,
      dashboardId: true,
      workcenterId: true,
      stationId: true,
      site: {
        select: {
          id: true,
          workspaceId: true,
          workspace: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
      },
    },
  });

  if (!display || display.status !== "CLAIMED" || !display.siteId || !display.site) {
    return iam;
  }

  return {
    principal: Principal.DISPLAY,
    validToken: true,
    displayId: display.id,
    siteId: display.siteId,
    workspaceId: display.site.workspaceId,
    display: {
      id: display.id,
      name: display.name,
      status: display.status,
      siteId: display.siteId,
      dashboardId: display.dashboardId,
      workcenterId: display.workcenterId,
      stationId: display.stationId,
    },
    workspace: {
      id: display.site.workspace.id,
      name: display.site.workspace.name,
      slug: display.site.workspace.slug,
    },
  };
}

declare module "fastify" {
  interface FastifyRequest {
    iam?: IAMContext;
  }
  interface FastifyInstance {
    verifyAccessToken: (
      request: import("fastify").FastifyRequest,
      reply: import("fastify").FastifyReply,
    ) => Promise<void>;
  }
}

async function resolveIAM(authHeader: string): Promise<IAMContext> {
  const iam: IAMContext = {
    principal: Principal.UNKNOWN,
    validToken: false,
  };

  if (!authHeader.startsWith(AUTH_HEADER_PREFIX)) {
    return iam;
  }

  const token = authHeader.substring(AUTH_HEADER_PREFIX.length);

  let decodedToken: DecodedAccessToken;
  try {
    decodedToken = verifyAccessToken(token);
  } catch {
    return iam;
  }

  if (isDisplayAccessToken(decodedToken)) {
    return resolveDisplayIAM(decodedToken.displayId);
  }

  return resolveUserIAM(decodedToken);
}

async function resolveUserIAM(decodedToken: LegacyDecodedUserAccessToken): Promise<IAMContext> {
  const invalidIAM: UnknownIAMContext = {
    principal: Principal.UNKNOWN,
    validToken: false,
  };

  const userResult = await prisma.user.findUnique({
    where: { id: decodedToken.id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      lockedUntil: true,
    },
  });

  if (!userResult) {
    return invalidIAM;
  }

  if (userResult.status !== "ACTIVE") {
    return invalidIAM;
  }

  if (userResult.lockedUntil && userResult.lockedUntil > new Date()) {
    return invalidIAM;
  }

  if (!decodedToken.workspaceId) {
    return invalidIAM;
  }

  const membership = await prisma.workspaceMembership.findUnique({
    where: {
      userId_workspaceId: {
        userId: decodedToken.id,
        workspaceId: decodedToken.workspaceId,
      },
    },
    select: {
      workspace: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  });

  if (!membership) {
    return invalidIAM;
  }

  if (decodedToken.siteId) {
    const sites = await listAccessibleSites(decodedToken.id, decodedToken.workspaceId);
    if (!sites.some((site) => site.id === decodedToken.siteId)) {
      return invalidIAM;
    }
  }

  return {
    principal: Principal.USER,
    validToken: true,
    id: decodedToken.id,
    email: userResult.email,
    workspaceId: decodedToken.workspaceId,
    siteId: decodedToken.siteId,
    workspace: membership.workspace,
    user: {
      id: userResult.id,
      email: userResult.email,
      firstName: userResult.firstName,
      lastName: userResult.lastName,
      status: userResult.status,
    },
  };
}

async function iamDecorator(request: FastifyRequest) {
  if (request.headers.authorization) {
    try {
      request.iam = await resolveIAM(request.headers.authorization);
    } catch {
      // Swallow error, IAM will remain undefined/invalid
    }
  }
}

async function verifyAccessTokenDecorator(request: FastifyRequest, _reply: FastifyReply) {
  if (!request.iam?.validToken || request.iam.principal !== Principal.USER) {
    throw createError.Unauthorized();
  }
}

async function authPluginImpl(server: FastifyInstance) {
  // Add IAM resolution to every request
  server.addHook("preHandler", iamDecorator);

  // Decorate with verification function for protected routes
  server.decorate("verifyAccessToken", verifyAccessTokenDecorator);
}

export const authPlugin = fp(authPluginImpl, {
  name: "authPlugin",
});
