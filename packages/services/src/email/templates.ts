import { getAppBaseUrl } from "@rw/infra/email";

interface InviteEmailParams {
  recipientEmail: string;
  inviteToken: string;
  inviterName?: string;
  workspaceName?: string;
}

interface ResetEmailParams {
  recipientEmail: string;
  resetToken: string;
}

function baseTemplate(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rockware</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  ${content}
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="font-size: 12px; color: #666;">
    This email was sent by Rockware. If you did not expect this email, you can safely ignore it.
  </p>
</body>
</html>
  `.trim();
}

export function createInviteEmailHtml(params: InviteEmailParams): string {
  const { inviteToken, inviterName, workspaceName } = params;
  const inviteUrl = `${getAppBaseUrl()}/invite?token=${inviteToken}`;

  const inviterText = inviterName ? `${inviterName} has` : "You have been";
  const workspaceText = workspaceName ? ` to join <strong>${workspaceName}</strong>` : "";

  return baseTemplate(`
    <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 20px;">You're Invited to Rockware</h1>
    <p>${inviterText} invited you${workspaceText}.</p>
    <p>Click the button below to create your account and get started:</p>
    <p style="margin: 30px 0;">
      <a href="${inviteUrl}" style="display: inline-block; background-color: #0066cc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">
        Accept Invitation
      </a>
    </p>
    <p style="font-size: 14px; color: #666;">
      Or copy and paste this link into your browser:<br>
      <a href="${inviteUrl}" style="color: #0066cc; word-break: break-all;">${inviteUrl}</a>
    </p>
    <p style="font-size: 14px; color: #666;">
      This invitation will expire in 7 days. If you did not expect this invitation, you can safely ignore this email.
    </p>
  `);
}

export function createInviteEmailText(params: InviteEmailParams): string {
  const { inviteToken, inviterName, workspaceName } = params;
  const inviteUrl = `${getAppBaseUrl()}/invite?token=${inviteToken}`;

  const inviterText = inviterName ? `${inviterName} has` : "You have been";
  const workspaceText = workspaceName ? ` to join ${workspaceName}` : "";

  return `
You're Invited to Rockware

${inviterText} invited you${workspaceText}.

Click the link below to create your account and get started:

${inviteUrl}

This invitation will expire in 7 days. If you did not expect this invitation, you can safely ignore this email.

---
This email was sent by Rockware.
  `.trim();
}

export function createResetEmailHtml(params: ResetEmailParams): string {
  const { resetToken } = params;
  const resetUrl = `${getAppBaseUrl()}/reset-password?token=${resetToken}`;

  return baseTemplate(`
    <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 20px;">Reset Your Password</h1>
    <p>We received a request to reset your Rockware password.</p>
    <p>Click the button below to choose a new password:</p>
    <p style="margin: 30px 0;">
      <a href="${resetUrl}" style="display: inline-block; background-color: #0066cc; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">
        Reset Password
      </a>
    </p>
    <p style="font-size: 14px; color: #666;">
      Or copy and paste this link into your browser:<br>
      <a href="${resetUrl}" style="color: #0066cc; word-break: break-all;">${resetUrl}</a>
    </p>
    <p style="font-size: 14px; color: #666;">
      This link will expire in 1 hour. If you did not request a password reset, you can safely ignore this email.
    </p>
  `);
}

export function createResetEmailText(params: ResetEmailParams): string {
  const { resetToken } = params;
  const resetUrl = `${getAppBaseUrl()}/reset-password?token=${resetToken}`;

  return `
Reset Your Password

We received a request to reset your Rockware password.

Click the link below to choose a new password:

${resetUrl}

This link will expire in 1 hour. If you did not request a password reset, you can safely ignore this email.

---
This email was sent by Rockware.
  `.trim();
}
