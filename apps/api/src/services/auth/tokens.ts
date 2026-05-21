import { createSigner, createVerifier } from "fast-jwt";
import { createHash, randomBytes } from "node:crypto";
import prisma from "@rw/db";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const ACCESS_TOKEN_EXPIRY = 15 * 60 * 1000; // 15 minutes
const REFRESH_TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface AccessTokenPayload {
  principal?: "USER";
  id: string;
  email: string;
  workspaceId?: string;
  siteId?: string;
}

export interface DisplayAccessTokenPayload {
  principal: "DISPLAY";
  displayId: string;
  siteId: string;
  workspaceId: string;
}

export type AnyAccessTokenPayload = AccessTokenPayload | DisplayAccessTokenPayload;

export type DecodedAccessToken = AnyAccessTokenPayload & {
  iat: number;
  exp: number;
};

const accessTokenSigner = createSigner({
  key: JWT_SECRET,
  expiresIn: ACCESS_TOKEN_EXPIRY,
});

const accessTokenVerifier = createVerifier({
  key: JWT_SECRET,
});

export function createAccessToken(payload: AnyAccessTokenPayload): string {
  if (payload.principal === "DISPLAY") {
    return accessTokenSigner(payload);
  }

  return accessTokenSigner({
    ...payload,
    principal: "USER",
  });
}

export function verifyAccessToken(token: string): DecodedAccessToken {
  return accessTokenVerifier(token) as DecodedAccessToken;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createRefreshToken(
  userId: string,
  metadata?: { userAgent?: string; ipAddress?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY);

  await prisma.refreshToken.create({
    data: {
      tokenHash,
      expiresAt,
      userAgent: metadata?.userAgent,
      ipAddress: metadata?.ipAddress,
      userId,
    },
  });

  return { token, expiresAt };
}

export async function createDisplayRefreshToken(
  displayId: string,
  metadata?: { userAgent?: string; ipAddress?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY);

  await prisma.displayRefreshToken.create({
    data: {
      tokenHash,
      expiresAt,
      userAgent: metadata?.userAgent,
      ipAddress: metadata?.ipAddress,
      displayId,
    },
  });

  return { token, expiresAt };
}

export async function verifyRefreshToken(token: string): Promise<{
  valid: boolean;
  userId?: string;
  tokenId?: string;
}> {
  const tokenHash = hashToken(token);

  const refreshToken = await prisma.refreshToken.findUnique({
    where: { tokenHash },
  });

  if (!refreshToken) {
    return { valid: false };
  }

  if (refreshToken.revokedAt) {
    return { valid: false };
  }

  if (refreshToken.expiresAt < new Date()) {
    return { valid: false };
  }

  return {
    valid: true,
    userId: refreshToken.userId,
    tokenId: refreshToken.id,
  };
}

export async function verifyDisplayRefreshToken(token: string): Promise<{
  valid: boolean;
  displayId?: string;
  tokenId?: string;
}> {
  const tokenHash = hashToken(token);

  const refreshToken = await prisma.displayRefreshToken.findUnique({
    where: { tokenHash },
  });

  if (!refreshToken) {
    return { valid: false };
  }

  if (refreshToken.revokedAt) {
    return { valid: false };
  }

  if (refreshToken.expiresAt < new Date()) {
    return { valid: false };
  }

  return {
    valid: true,
    displayId: refreshToken.displayId,
    tokenId: refreshToken.id,
  };
}

export async function revokeRefreshToken(token: string): Promise<boolean> {
  const tokenHash = hashToken(token);

  try {
    await prisma.refreshToken.update({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });
    return true;
  } catch {
    return false;
  }
}

export async function revokeDisplayRefreshToken(token: string): Promise<boolean> {
  const tokenHash = hashToken(token);

  try {
    await prisma.displayRefreshToken.update({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });
    return true;
  } catch {
    return false;
  }
}

export async function revokeAllUserRefreshTokens(userId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: {
      userId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export async function revokeAllDisplayRefreshTokens(displayId: string): Promise<number> {
  const result = await prisma.displayRefreshToken.updateMany({
    where: {
      displayId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

export async function cleanupExpiredTokens(): Promise<number> {
  const result = await prisma.refreshToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }],
    },
  });
  return result.count;
}

export async function cleanupExpiredDisplayTokens(): Promise<number> {
  const result = await prisma.displayRefreshToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }],
    },
  });
  return result.count;
}
