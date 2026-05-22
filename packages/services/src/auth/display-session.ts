import prisma from "@rw/db";
import {
  createAccessToken,
  createDisplayRefreshToken,
  hashToken,
  revokeDisplayRefreshToken,
  verifyDisplayRefreshToken,
  type DisplayAccessTokenPayload,
} from "./tokens.js";

export interface DisplayTokenPair {
  [x: string]: unknown;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface DisplayAuthContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface DisplayAuthResult extends DisplayTokenPair {
  [x: string]: unknown;
  display: {
    [x: string]: unknown;
    id: string;
    name: string | null;
    status: string;
    siteId: string;
    dashboardId: string | null;
    workcenterId: string | null;
    stationId: string | null;
    workspaceId: string;
  };
}

async function getDisplayAuthRecord(displayId: string) {
  return prisma.display.findUnique({
    where: { id: displayId },
    select: {
      id: true,
      name: true,
      status: true,
      siteId: true,
      dashboardId: true,
      workcenterId: true,
      stationId: true,
      bootstrapSecretHash: true,
      site: {
        select: {
          workspaceId: true,
        },
      },
    },
  });
}

function toDisplayAccessPayload(display: {
  id: string;
  siteId: string;
  workspaceId: string;
}): DisplayAccessTokenPayload {
  return {
    principal: "DISPLAY",
    displayId: display.id,
    siteId: display.siteId,
    workspaceId: display.workspaceId,
  };
}

export async function loginDisplay(
  displayId: string,
  bootstrapSecret: string,
  metadata?: DisplayAuthContext,
): Promise<{ success: true; data: DisplayAuthResult } | { success: false; error: string }> {
  const display = await getDisplayAuthRecord(displayId);

  if (!display?.bootstrapSecretHash || hashToken(bootstrapSecret) !== display.bootstrapSecretHash) {
    return { success: false, error: "Invalid display credentials" };
  }

  if (display.status !== "CLAIMED") {
    return { success: false, error: "Display has not been claimed" };
  }

  if (!display.siteId || !display.site?.workspaceId) {
    return { success: false, error: "Display is missing site configuration" };
  }

  const accessToken = createAccessToken(
    toDisplayAccessPayload({
      id: display.id,
      siteId: display.siteId,
      workspaceId: display.site.workspaceId,
    }),
  );
  const { token: refreshToken, expiresAt } = await createDisplayRefreshToken(display.id, metadata);

  await prisma.display.update({
    where: { id: display.id },
    data: { bootstrapSecretLastUsedAt: new Date() },
  });

  return {
    success: true,
    data: {
      accessToken,
      refreshToken,
      expiresAt,
      display: {
        id: display.id,
        name: display.name,
        status: display.status,
        siteId: display.siteId,
        dashboardId: display.dashboardId,
        workcenterId: display.workcenterId,
        stationId: display.stationId,
        workspaceId: display.site.workspaceId,
      },
    },
  };
}

export async function refreshDisplaySession(
  refreshToken: string,
  metadata?: DisplayAuthContext,
): Promise<{ success: true; data: DisplayTokenPair } | { success: false; error: string }> {
  const verification = await verifyDisplayRefreshToken(refreshToken);

  if (!verification.valid || !verification.displayId) {
    return { success: false, error: "Invalid or expired refresh token" };
  }

  await revokeDisplayRefreshToken(refreshToken);

  const display = await getDisplayAuthRecord(verification.displayId);

  if (!display || display.status !== "CLAIMED") {
    return { success: false, error: "Display is not active" };
  }

  if (!display.siteId || !display.site?.workspaceId) {
    return { success: false, error: "Display is missing site configuration" };
  }

  const accessToken = createAccessToken(
    toDisplayAccessPayload({
      id: display.id,
      siteId: display.siteId,
      workspaceId: display.site.workspaceId,
    }),
  );
  const { token: newRefreshToken, expiresAt } = await createDisplayRefreshToken(display.id, metadata);

  return {
    success: true,
    data: {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt,
    },
  };
}

export async function logoutDisplay(refreshToken: string): Promise<boolean> {
  return revokeDisplayRefreshToken(refreshToken);
}
