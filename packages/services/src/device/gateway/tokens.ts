import { createHash } from "node:crypto";
import { customAlphabet } from "nanoid";
import prisma from "@rw/db";

const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
const generateToken = customAlphabet(alphabet, 32);

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreateTokenInput {
  gatewayId: string;
  name?: string;
  expiresIn?: number; // seconds
}

export interface TokenValidationResult {
  token: {
    id: string;
    name: string | null;
    gatewayId: string;
  };
  gateway: {
    id: string;
    status: string;
    serialNumber: string;
    metadata: unknown;
  };
}

/**
 * Create a new token for a gateway
 * Returns the token object AND the plaintext token (only time it's available)
 */
export async function create(input: CreateTokenInput) {
  const { gatewayId, name, expiresIn } = input;

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

  const gatewayToken = await prisma.gatewayToken.create({
    data: {
      name,
      tokenHash,
      expiresAt,
      gatewayId,
    },
  });

  return {
    id: gatewayToken.id,
    name: gatewayToken.name,
    token, // plaintext - only returned on creation
    createdAt: gatewayToken.createdAt,
    expiresAt: gatewayToken.expiresAt,
  };
}

/**
 * Validate a bearer token and return the associated gateway
 * Returns null if token is invalid, revoked, or expired
 */
export async function validate(token: string): Promise<TokenValidationResult | null> {
  const tokenHash = hashToken(token);

  const gatewayToken = await prisma.gatewayToken.findUnique({
    where: { tokenHash },
    include: { gateway: true },
  });

  if (!gatewayToken) {
    return null;
  }

  if (gatewayToken.revokedAt) {
    return null;
  }

  if (gatewayToken.expiresAt && gatewayToken.expiresAt < new Date()) {
    return null;
  }

  // Update last used
  await prisma.gatewayToken.update({
    where: { id: gatewayToken.id },
    data: { lastUsed: new Date() },
  });

  return {
    token: {
      id: gatewayToken.id,
      name: gatewayToken.name,
      gatewayId: gatewayToken.gatewayId,
    },
    gateway: {
      id: gatewayToken.gateway.id,
      status: gatewayToken.gateway.status,
      serialNumber: gatewayToken.gateway.serialNumber,
      metadata: gatewayToken.gateway.metadata,
    },
  };
}

/**
 * Revoke a token
 */
export async function revoke(gatewayId: string, tokenId: string) {
  const token = await prisma.gatewayToken.findFirst({
    where: {
      id: tokenId,
      gatewayId,
    },
  });

  if (!token) {
    return null;
  }

  if (token.revokedAt) {
    return { alreadyRevoked: true, revokedAt: token.revokedAt };
  }

  const revokedToken = await prisma.gatewayToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date() },
  });

  return {
    success: true,
    revokedAt: revokedToken.revokedAt,
  };
}

/**
 * Create initial token during claim process
 */
export async function createClaimToken(gatewayId: string) {
  const token = generateToken();
  const tokenHash = hashToken(token);

  await prisma.gatewayToken.create({
    data: {
      name: "Initial token",
      tokenHash,
      gatewayId,
    },
  });

  return token;
}

/**
 * Clear claim code after successful claim
 */
export async function clearClaimCode(gatewayId: string) {
  await prisma.gateway.update({
    where: { id: gatewayId },
    data: { claimCode: null },
  });
}
