import { getDefaultFromAddress } from "@rw/runtime/email";
import { getEmailClient, isEmailEnabled } from "@rw/runtime/email";
import {
  createAlertEmailHtml,
  createAlertEmailText,
  createInviteEmailHtml,
  createInviteEmailText,
  createResetEmailHtml,
  createResetEmailText,
} from "./templates.js";

interface SendInviteParams {
  to: string;
  inviteToken: string;
  inviterName?: string;
  workspaceName?: string;
}

interface SendResetParams {
  to: string;
  resetToken: string;
}

interface SendAlertParams {
  to: string | string[];
  subject: string;
  message: string;
}

interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendInviteEmail(params: SendInviteParams): Promise<SendResult> {
  const { to, inviteToken, inviterName, workspaceName } = params;

  if (!isEmailEnabled()) {
    console.log(`[EMAIL DISABLED] Would send invite to ${to} with token: ${inviteToken}`);
    return { success: true, messageId: "disabled" };
  }

  const client = getEmailClient();
  if (!client) {
    return { success: false, error: "Email client not configured" };
  }

  try {
    const { data, error } = await client.emails.send({
      from: getDefaultFromAddress(),
      to,
      subject: inviterName ? `${inviterName} invited you to Rockware` : "You're invited to Rockware",
      html: createInviteEmailHtml({ recipientEmail: to, inviteToken, inviterName, workspaceName }),
      text: createInviteEmailText({ recipientEmail: to, inviteToken, inviterName, workspaceName }),
    });

    if (error) {
      console.error("[EMAIL] Failed to send invite:", error);
      return { success: false, error: error.message };
    }

    return { success: true, messageId: data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[EMAIL] Exception sending invite:", message);
    return { success: false, error: message };
  }
}

/**
 * Send an automation alert. Subject + message are supplied by the firing automation (the message is
 * already interpolated by the engine). Recipients are pre-resolved email addresses.
 */
export async function sendAlertEmail(params: SendAlertParams): Promise<SendResult> {
  const { to, subject, message } = params;
  const recipients = Array.isArray(to) ? to : [to];

  if (recipients.length === 0) {
    return { success: false, error: "No recipients" };
  }

  if (!isEmailEnabled()) {
    console.log(`[EMAIL DISABLED] Would send alert "${subject}" to ${recipients.join(", ")}`);
    return { success: true, messageId: "disabled" };
  }

  const client = getEmailClient();
  if (!client) {
    return { success: false, error: "Email client not configured" };
  }

  try {
    const { data, error } = await client.emails.send({
      from: getDefaultFromAddress(),
      to: recipients,
      subject,
      html: createAlertEmailHtml({ subject, message }),
      text: createAlertEmailText({ subject, message }),
    });

    if (error) {
      console.error("[EMAIL] Failed to send alert:", error);
      return { success: false, error: error.message };
    }

    return { success: true, messageId: data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[EMAIL] Exception sending alert:", message);
    return { success: false, error: message };
  }
}

export async function sendPasswordResetEmail(params: SendResetParams): Promise<SendResult> {
  const { to, resetToken } = params;

  if (!isEmailEnabled()) {
    console.log(`[EMAIL DISABLED] Would send password reset to ${to} with token: ${resetToken}`);
    return { success: true, messageId: "disabled" };
  }

  const client = getEmailClient();
  if (!client) {
    return { success: false, error: "Email client not configured" };
  }

  try {
    const { data, error } = await client.emails.send({
      from: getDefaultFromAddress(),
      to,
      subject: "Reset your Rockware password",
      html: createResetEmailHtml({ recipientEmail: to, resetToken }),
      text: createResetEmailText({ recipientEmail: to, resetToken }),
    });

    if (error) {
      console.error("[EMAIL] Failed to send password reset:", error);
      return { success: false, error: error.message };
    }

    return { success: true, messageId: data?.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[EMAIL] Exception sending password reset:", message);
    return { success: false, error: message };
  }
}
