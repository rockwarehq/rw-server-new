import { createHash, randomBytes } from "node:crypto";
import prisma from "@rw/db";
import { securityConfig } from "../../../config.js";
import { hashPassword, comparePassword } from "../../auth/session.js";
import { sendPasswordResetEmail } from "@rw/services/email/index";
import { logEvent } from "@rw/services/audit/index";
import { validatePasswordStrength } from "../../validation.js";

export interface ResetRequestResult {
  email: string;
  expiresAt: Date;
  emailSent: boolean;
}

export interface ResetContext {
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Generate a secure random token and its SHA256 hash
 */
function generateToken(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(plaintext).digest("hex");
  return { plaintext, hash };
}

/**
 * Hash a token for database lookup
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function initiateReset(
  email: string,
  context?: ResetContext,
): Promise<{ success: true; data: ResetRequestResult } | { success: false; error: string }> {
  const normalizedEmail = email.toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user) {
    // Don't reveal if user exists - return success message anyway
    // But don't log anything to avoid enumeration via audit logs
    return {
      success: true,
      data: {
        email: normalizedEmail,
        expiresAt: new Date(Date.now() + securityConfig.resetTokenExpiryMs),
        emailSent: false, // No email sent since user doesn't exist
      },
    };
  }

  if (user.status === "DISABLED") {
    // Log the attempt but return generic message
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "account_disabled" },
    });
    return {
      success: true,
      data: {
        email: normalizedEmail,
        expiresAt: new Date(Date.now() + securityConfig.resetTokenExpiryMs),
        emailSent: false,
      },
    };
  }

  if (user.status === "PENDING") {
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "registration_incomplete" },
    });
    return {
      success: true,
      data: {
        email: normalizedEmail,
        expiresAt: new Date(Date.now() + securityConfig.resetTokenExpiryMs),
        emailSent: false,
      },
    };
  }

  const { plaintext, hash } = generateToken();
  const resetTokenExpiry = new Date(Date.now() + securityConfig.resetTokenExpiryMs);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetTokenHash: hash,
      resetTokenExpiry,
      resetAttempts: 0, // Reset attempts on new request
    },
  });

  // Send password reset email
  const emailResult = await sendPasswordResetEmail({
    to: user.email,
    resetToken: plaintext,
  });

  await logEvent({
    action: "PASSWORD_RESET_REQUESTED",
    userId: user.id,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
    metadata: { emailSent: emailResult.success },
  });

  return {
    success: true,
    data: {
      email: user.email,
      expiresAt: resetTokenExpiry,
      emailSent: emailResult.success,
    },
  };
}

export async function verifyResetToken(
  token: string,
  context?: ResetContext,
): Promise<{ valid: boolean; user?: { id: string; email: string }; error?: string }> {
  const tokenHash = hashToken(token);

  const user = await prisma.user.findUnique({
    where: { resetTokenHash: tokenHash },
    select: {
      id: true,
      email: true,
      status: true,
      resetTokenExpiry: true,
      resetAttempts: true,
    },
  });

  if (!user) {
    return { valid: false, error: "Invalid reset token" };
  }

  // Check if token has been invalidated due to too many attempts
  if (user.resetAttempts >= securityConfig.maxTokenAttempts) {
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "max_attempts_exceeded", attempts: user.resetAttempts },
    });
    return { valid: false, error: "Reset token has been invalidated due to too many failed attempts" };
  }

  if (user.status !== "ACTIVE") {
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: user.status === "DISABLED" ? "account_disabled" : "registration_incomplete" },
    });
    return { valid: false, error: "Account is not active" };
  }

  if (user.resetTokenExpiry && user.resetTokenExpiry < new Date()) {
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "token_expired" },
    });
    return { valid: false, error: "Reset token has expired" };
  }

  return {
    valid: true,
    user: {
      id: user.id,
      email: user.email,
    },
  };
}

export async function resetPassword(
  token: string,
  newPassword: string,
  context?: ResetContext,
): Promise<{ success: true } | { success: false; error: string; details?: string[] }> {
  // Validate password strength
  const passwordValidation = validatePasswordStrength(newPassword);
  if (!passwordValidation.valid) {
    return { success: false, error: "Password does not meet requirements", details: passwordValidation.errors };
  }

  const tokenHash = hashToken(token);

  const user = await prisma.user.findUnique({
    where: { resetTokenHash: tokenHash },
    select: {
      id: true,
      status: true,
      resetTokenExpiry: true,
      resetAttempts: true,
    },
  });

  if (!user) {
    return { success: false, error: "Invalid or expired reset token" };
  }

  // Check if max attempts reached
  if (user.resetAttempts >= securityConfig.maxTokenAttempts) {
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "max_attempts_exceeded" },
    });
    return { success: false, error: "Reset token has been invalidated due to too many failed attempts" };
  }

  if (user.status !== "ACTIVE") {
    await prisma.user.update({
      where: { id: user.id },
      data: { resetAttempts: { increment: 1 } },
    });
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: user.status === "DISABLED" ? "account_disabled" : "registration_incomplete" },
    });
    return { success: false, error: "Account is not active" };
  }

  if (user.resetTokenExpiry && user.resetTokenExpiry < new Date()) {
    await prisma.user.update({
      where: { id: user.id },
      data: { resetAttempts: { increment: 1 } },
    });
    await logEvent({
      action: "PASSWORD_RESET_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "token_expired" },
    });
    return { success: false, error: "Reset token has expired" };
  }

  const passwordHash = await hashPassword(newPassword);

  const sessionsRevoked = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetTokenHash: null,
        resetTokenExpiry: null,
        resetAttempts: 0,
      },
    });

    const result = await tx.refreshToken.updateMany({
      where: {
        userId: user.id,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    return result.count;
  });

  await logEvent({
    action: "PASSWORD_RESET_COMPLETED",
    userId: user.id,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
    metadata: { sessionsRevoked },
  });

  return { success: true };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  context?: ResetContext,
): Promise<{ success: true } | { success: false; error: string; details?: string[] }> {
  // Validate password strength
  const passwordValidation = validatePasswordStrength(newPassword);
  if (!passwordValidation.valid) {
    return { success: false, error: "Password does not meet requirements", details: passwordValidation.errors };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      passwordHash: true,
      status: true,
    },
  });

  if (!user) {
    return { success: false, error: "User not found" };
  }

  if (user.status !== "ACTIVE") {
    return { success: false, error: "Account is not active" };
  }

  if (!user.passwordHash) {
    return { success: false, error: "No password set for this account" };
  }

  const isValid = await comparePassword(currentPassword, user.passwordHash);
  if (!isValid) {
    await logEvent({
      action: "PASSWORD_CHANGED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { success: false, reason: "incorrect_current_password" },
    });
    return { success: false, error: "Current password is incorrect" };
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });

  await logEvent({
    action: "PASSWORD_CHANGED",
    userId: user.id,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
    metadata: { success: true },
  });

  return { success: true };
}
