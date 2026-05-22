import { createHash, randomBytes } from "node:crypto";
import prisma from "@rw/db";
import { securityConfig } from "../../../config.js";
import { hasOwnerPermission, hasPermission, OWNER_PERMISSION } from "@rw/services/iam/index";
import { hashPassword } from "../../auth/session.js";
import * as employeeService from "../../employee/index.js";
import { sendInviteEmail } from "@rw/services/email/index";
import { logEvent } from "@rw/services/audit/index";
import { validatePasswordStrength } from "../../validation.js";

export interface CreateInviteInput {
  email: string;
  inviterId: string;
  workspaceId: string;
  context?: InviteContext;
  /**
   * Role id to assign to new invitees. Required for new invites, optional for
   * resending an existing pending invite. Workspace roles assign at workspace
   * scope; site roles assign to `siteId` or the caller's site fallback.
   */
  roleId?: string;
  siteId?: string;
  fallbackSiteId?: string;
}

export interface InviteResult {
  [x: string]: unknown;
  user: {
    [x: string]: unknown;
    id: string;
    email: string;
    status: string;
  };
  expiresAt: Date;
  emailSent: boolean;
}

export interface CompleteInviteInput {
  token: string;
  password: string;
  firstName?: string;
  lastName?: string;
  employeeNumber?: string | null;
  badgeNumber?: string | null;
  pin?: string;
}

export interface InviteContext {
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

interface InviteAssignment {
  roleId: string;
  siteId: string | null;
  scope: "WORKSPACE" | "SITE";
  isOwner: boolean;
}

async function resolveInviteAssignment(input: {
  workspaceId: string;
  roleId?: string;
  siteId?: string;
  fallbackSiteId?: string;
}): Promise<{ ok: true; assignment: InviteAssignment } | { ok: false; error: string }> {
  if (!input.roleId) {
    return { ok: false, error: "roleId is required" };
  }

  const role = await prisma.role.findUnique({
    where: { id: input.roleId },
    select: { id: true, name: true, scope: true, workspaceId: true, isSystem: true, permissions: true },
  });
  if (!role) return { ok: false, error: "Role not found" };
  if (role.workspaceId !== input.workspaceId) {
    return { ok: false, error: "Role does not belong to this workspace" };
  }

  const isOwner = hasOwnerPermission(role.permissions);
  if (isOwner && (!role.isSystem || role.scope !== "WORKSPACE")) {
    return { ok: false, error: `${OWNER_PERMISSION} is reserved for workspace system roles` };
  }

  if (role.scope === "WORKSPACE") {
    if (input.siteId) {
      return { ok: false, error: "siteId cannot be used with a workspace-scoped role" };
    }
    return { ok: true, assignment: { roleId: role.id, siteId: null, scope: "WORKSPACE", isOwner } };
  }

  const siteId = input.siteId ?? input.fallbackSiteId;
  if (!siteId) {
    return { ok: false, error: "siteId is required for site-scoped invite roles" };
  }

  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { workspaceId: true },
  });
  if (!site) return { ok: false, error: "Site not found" };
  if (site.workspaceId !== input.workspaceId) {
    return { ok: false, error: "Site does not belong to this workspace" };
  }

  return { ok: true, assignment: { roleId: role.id, siteId, scope: "SITE", isOwner: false } };
}

async function canInviteAssignment(inviterId: string, workspaceId: string, assignment: InviteAssignment) {
  if (assignment.isOwner) {
    return hasPermission(inviterId, OWNER_PERMISSION, { workspaceId });
  }

  return hasPermission(inviterId, "user:write", {
    workspaceId,
    ...(assignment.siteId ? { siteId: assignment.siteId } : {}),
  });
}

async function canResendPendingInvite(inviterId: string, workspaceId: string, pendingUserId: string) {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: pendingUserId, workspaceId } },
    select: {
      roleAssignments: {
        select: {
          siteId: true,
          role: { select: { permissions: true } },
        },
      },
    },
  });

  if (!membership || membership.roleAssignments.length === 0) {
    return false;
  }

  if (membership.roleAssignments.some((assignment) => hasOwnerPermission(assignment.role.permissions))) {
    return hasPermission(inviterId, OWNER_PERMISSION, { workspaceId });
  }

  for (const assignment of membership.roleAssignments) {
    const ok = await hasPermission(inviterId, "user:write", {
      workspaceId,
      ...(assignment.siteId ? { siteId: assignment.siteId } : {}),
    });
    if (ok) return true;
  }

  return false;
}

export async function createInvite(
  input: CreateInviteInput,
): Promise<{ success: true; data: InviteResult } | { success: false; error: string }> {
  const { email, inviterId, workspaceId, context } = input;

  const normalizedEmail = email.toLowerCase();

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (existingUser) {
    if (existingUser.systemRole) {
      return { success: false, error: "Cannot invite a system user to a workspace" };
    }
    if (existingUser.status === "ACTIVE") {
      return { success: false, error: "User with this email already exists" };
    }

    const canResend = await canResendPendingInvite(inviterId, workspaceId, existingUser.id);
    if (!canResend) {
      return { success: false, error: "Forbidden" };
    }

    // User exists but is pending - resend invite
    const { plaintext, hash } = generateToken();
    const inviteTokenExpiry = new Date(Date.now() + securityConfig.inviteTokenExpiryMs);

    try {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: existingUser.id },
          data: {
            inviteTokenHash: hash,
            inviteTokenExpiry,
            inviteAttempts: 0, // Reset attempts on new invite
            invitedBy: inviterId,
            invitedAt: new Date(),
          },
        });

        // Resend refreshes invite delivery only. Role/membership changes are
        // explicit member-management actions and are not hidden in resend.
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not create invite";
      return { success: false, error: message };
    }

    // Get inviter and workspace info for email
    const [inviter, workspace] = await Promise.all([
      inviterId
        ? prisma.user.findUnique({ where: { id: inviterId }, select: { firstName: true, lastName: true } })
        : null,
      workspaceId ? prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }) : null,
    ]);

    const inviterName = inviter
      ? [inviter.firstName, inviter.lastName].filter(Boolean).join(" ") || undefined
      : undefined;

    // Send invite email
    const emailResult = await sendInviteEmail({
      to: normalizedEmail,
      inviteToken: plaintext,
      inviterName,
      workspaceName: workspace?.name,
    });

    // Log the event
    await logEvent({
      action: "USER_INVITED",
      userId: existingUser.id,
      actorId: inviterId,
      workspaceId,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: {
        resent: true,
        emailSent: emailResult.success,
      },
    });

    return {
      success: true,
      data: {
        user: {
          id: existingUser.id,
          email: existingUser.email,
          status: existingUser.status,
        },
        expiresAt: inviteTokenExpiry,
        emailSent: emailResult.success,
      },
    };
  }

  // Create new user with invite token
  const resolveResult = await resolveInviteAssignment(input);
  if (!resolveResult.ok) {
    return { success: false, error: resolveResult.error };
  }
  const assignment = resolveResult.assignment;

  if (!(await canInviteAssignment(inviterId, workspaceId, assignment))) {
    return { success: false, error: "Forbidden" };
  }

  const { plaintext, hash } = generateToken();
  const inviteTokenExpiry = new Date(Date.now() + securityConfig.inviteTokenExpiryMs);

  let user: { id: string; email: string; status: string };
  try {
    user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: normalizedEmail,
          status: "PENDING",
          inviteTokenHash: hash,
          inviteTokenExpiry,
          inviteAttempts: 0,
          invitedBy: inviterId,
          invitedAt: new Date(),
        },
      });

      const membership = await tx.workspaceMembership.create({
        data: { workspaceId, userId: createdUser.id },
        select: { id: true },
      });

      await tx.roleAssignment.create({
        data: { membershipId: membership.id, roleId: assignment.roleId, siteId: assignment.siteId },
      });

      return createdUser;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create invite";
    return { success: false, error: message };
  }

  // Get inviter and workspace info for email
  const [inviter, workspace] = await Promise.all([
    inviterId
      ? prisma.user.findUnique({ where: { id: inviterId }, select: { firstName: true, lastName: true } })
      : null,
    workspaceId ? prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }) : null,
  ]);

  const inviterName = inviter
    ? [inviter.firstName, inviter.lastName].filter(Boolean).join(" ") || undefined
    : undefined;

  // Send invite email
  const emailResult = await sendInviteEmail({
    to: normalizedEmail,
    inviteToken: plaintext,
    inviterName,
    workspaceName: workspace?.name,
  });

  // Log the event
  await logEvent({
    action: "USER_INVITED",
    userId: user.id,
    actorId: inviterId,
    workspaceId,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
    metadata: {
      resent: false,
      emailSent: emailResult.success,
      roleId: assignment.roleId,
      siteId: assignment.siteId,
    },
  });

  return {
    success: true,
    data: {
      user: {
        id: user.id,
        email: user.email,
        status: user.status,
      },
      expiresAt: inviteTokenExpiry,
      emailSent: emailResult.success,
    },
  };
}

export async function verifyInviteToken(
  token: string,
  context?: InviteContext,
): Promise<{ valid: boolean; user?: { id: string; email: string }; error?: string }> {
  const tokenHash = hashToken(token);

  const user = await prisma.user.findUnique({
    where: { inviteTokenHash: tokenHash },
    select: {
      id: true,
      email: true,
      status: true,
      inviteTokenExpiry: true,
      inviteAttempts: true,
    },
  });

  if (!user) {
    // Don't log for invalid tokens to avoid log spam from enumeration attempts
    return { valid: false, error: "Invalid invite token" };
  }

  // Check if token has been invalidated due to too many attempts
  if (user.inviteAttempts >= securityConfig.maxTokenAttempts) {
    await logEvent({
      action: "INVITE_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "max_attempts_exceeded", attempts: user.inviteAttempts },
    });
    return { valid: false, error: "Invite token has been invalidated due to too many failed attempts" };
  }

  if (user.status !== "PENDING") {
    await logEvent({
      action: "INVITE_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "user_not_pending", status: user.status },
    });
    return { valid: false, error: "User has already completed registration" };
  }

  if (user.inviteTokenExpiry && user.inviteTokenExpiry < new Date()) {
    await logEvent({
      action: "INVITE_EXPIRED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
    return { valid: false, error: "Invite token has expired" };
  }

  await logEvent({
    action: "INVITE_VERIFIED",
    userId: user.id,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
  });

  return {
    valid: true,
    user: {
      id: user.id,
      email: user.email,
    },
  };
}

export async function completeInvite(
  input: CompleteInviteInput,
  context?: InviteContext,
): Promise<
  { success: true; data: { id: string; email: string } } | { success: false; error: string; details?: string[] }
> {
  const { token, password, firstName, lastName, employeeNumber, badgeNumber, pin } = input;

  // Validate password strength
  const passwordValidation = validatePasswordStrength(password);
  if (!passwordValidation.valid) {
    return { success: false, error: "Password does not meet requirements", details: passwordValidation.errors };
  }

  const tokenHash = hashToken(token);

  // Find user and increment attempt counter atomically
  const user = await prisma.user.findUnique({
    where: { inviteTokenHash: tokenHash },
    select: {
      id: true,
      email: true,
      status: true,
      inviteTokenExpiry: true,
      inviteAttempts: true,
    },
  });

  if (!user) {
    return { success: false, error: "Invalid or expired invite token" };
  }

  // Check if max attempts reached
  if (user.inviteAttempts >= securityConfig.maxTokenAttempts) {
    await logEvent({
      action: "INVITE_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "max_attempts_exceeded" },
    });
    return { success: false, error: "Invite token has been invalidated due to too many failed attempts" };
  }

  if (user.status !== "PENDING") {
    // Increment attempts for suspicious activity
    await prisma.user.update({
      where: { id: user.id },
      data: { inviteAttempts: { increment: 1 } },
    });
    await logEvent({
      action: "INVITE_FAILED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { reason: "user_not_pending" },
    });
    return { success: false, error: "Invalid or expired invite token" };
  }

  if (user.inviteTokenExpiry && user.inviteTokenExpiry < new Date()) {
    await prisma.user.update({
      where: { id: user.id },
      data: { inviteAttempts: { increment: 1 } },
    });
    await logEvent({
      action: "INVITE_EXPIRED",
      userId: user.id,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
    return { success: false, error: "Invite token has expired" };
  }

  const passwordHash = await hashPassword(password);

  const profileFirstName = firstName?.trim() || user.email.split("@")[0];
  const profileLastName = lastName?.trim() || "";

  let updatedUser: { id: string; email: string };
  try {
    updatedUser = await prisma.$transaction(async (tx) => {
      const membershipRecords = await tx.workspaceMembership.findMany({
        where: { userId: user.id },
        select: { id: true, workspaceId: true, employeeId: true },
      });

      if (membershipRecords.length === 0) {
        throw new Error("User is not assigned to a workspace");
      }

      const memberships = membershipRecords.filter((membership) => membership.employeeId === null);
      const createdEmployees: Array<{ membershipId: string; employeeId: string }> = [];

      for (const membership of memberships) {
        const employee = await employeeService.crud.create(
          {
            workspaceId: membership.workspaceId,
            firstName: profileFirstName,
            lastName: profileLastName,
            employeeNumber,
            badgeNumber,
            pin,
          },
          tx,
        );
        createdEmployees.push({ membershipId: membership.id, employeeId: employee.data.id });
      }

      for (const employee of createdEmployees) {
        await tx.workspaceMembership.update({
          where: { id: employee.membershipId },
          data: { employeeId: employee.employeeId },
        });
      }

      return tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          firstName: profileFirstName,
          lastName: profileLastName,
          status: "ACTIVE",
          inviteTokenHash: null,
          inviteTokenExpiry: null,
          inviteAttempts: 0,
        },
        select: {
          id: true,
          email: true,
        },
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create employee profile";
    return { success: false, error: message };
  }

  await logEvent({
    action: "INVITE_COMPLETED",
    userId: user.id,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
  });

  return {
    success: true,
    data: updatedUser,
  };
}
