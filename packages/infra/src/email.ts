// Infrastructure adapter for transactional email (Resend).
// Knows about the Resend SDK + env vars. Knows NOTHING about business
// concepts like "invite email" or "password reset email" — those are domain
// templates in @rw/services/email/ that call into this adapter's sendEmail().

import { Resend } from "resend";

// ── Config read from process.env ─────────────────────────────────────────

const emailConfig = {
  apiKey: process.env.RESEND_API_KEY || "",
  defaultFromAddress: process.env.EMAIL_FROM || "noreply@notify.rockware.io",
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
  enabled: !!process.env.RESEND_API_KEY,
};

export function isEmailEnabled(): boolean {
  return emailConfig.enabled;
}

export function getDefaultFromAddress(): string {
  return emailConfig.defaultFromAddress;
}

export function getAppBaseUrl(): string {
  return emailConfig.appBaseUrl;
}

// ── Resend client singleton ──────────────────────────────────────────────

let resendClient: Resend | null = null;

export function getEmailClient(): Resend | null {
  if (!emailConfig.enabled) {
    return null;
  }
  if (!resendClient) {
    resendClient = new Resend(emailConfig.apiKey);
  }
  return resendClient;
}

// ── Pass-through sendEmail ──────────────────────────────────────────────
// Domain callers in @rw/services/email/ build specific email types (invite,
// password reset, alert) and call this. The signature mirrors Resend's
// emails.send so swapping providers later is a one-file change here.

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
}

export async function sendEmail(params: SendEmailParams): Promise<void> {
  const client = getEmailClient();
  if (!client) {
    console.warn("[email] sendEmail called but email is disabled (RESEND_API_KEY unset)");
    return;
  }
  await client.emails.send({
    from: params.from ?? emailConfig.defaultFromAddress,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
  });
}
