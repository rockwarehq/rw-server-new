import type { BridgeConfig } from "./types.js";

export const env = {
  nodeId: process.env.NODE_ID || "gateway-001",
  isDevelopment: process.env.NODE_ENV !== "production",
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV !== "production" ? "debug" : "info"),
};

export const serverConfig = {
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 30000,
  // Bind to IPv6 wildcard '::' for dual-stack — Linux's IPV6_V6ONLY=0
  // default makes this accept both IPv4 and IPv6 connections. Binding to
  // '0.0.0.0' would accept IPv4 only, which breaks cross-app traffic on
  // fly's 6PN network (apps reach each other by IPv6 via <app>.internal).
  host: process.env.HOST || "::",
  graceDelay: parseInt(process.env.CLOSE_GRACE_DELAY || "", 10) || 500, // milliseconds
};

export const bridgeConfig: BridgeConfig = {
  nodeId: env.nodeId,
  connectionUrl: process.env.MQTT_BRIDGE_CONNECTION_URL || "mqtt://localhost:1883",
  clean: true,
  reconnectPeriod: parseInt(process.env.MQTT_BRIDGE_RECONNECT_PERIOD || "", 10) || 1000,
  keepalive: parseInt(process.env.MQTT_BRIDGE_KEEPALIVE || "", 10) || 60,
  approvedDevices: process.env.APPROVED_DEVICES ? process.env.APPROVED_DEVICES.split(",") : [],
};

export const emailConfig = {
  apiKey: process.env.RESEND_API_KEY || "",
  fromAddress: process.env.EMAIL_FROM || "noreply@notify.rockware.io",
  baseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
  enabled: !!process.env.RESEND_API_KEY,
};

export const securityConfig = {
  // Token expiry
  inviteTokenExpiryMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  resetTokenExpiryMs: 60 * 60 * 1000, // 1 hour

  // Brute-force protection
  maxTokenAttempts: 5, // Invalidate token after this many failed attempts
  maxLoginAttempts: 5, // Lock account after this many failed attempts
  loginLockoutMs: 15 * 60 * 1000, // 15 minutes

  // Rate limiting (requests per minute)
  rateLimitSensitive: 5, // For login, invite, reset endpoints
  rateLimitDefault: 100, // For general API endpoints
};

const processorSharedSecret = process.env.PROCESSOR_SHARED_SECRET || "";

export const processorConfig = {
  sharedSecret: processorSharedSecret,
  cacheRefreshUrl: process.env.PROCESSOR_CACHE_REFRESH_URL || "",
  cacheRefreshSecret: process.env.PROCESSOR_CACHE_REFRESH_SECRET || processorSharedSecret,
  cacheRefreshTimeoutMs: parseInt(process.env.PROCESSOR_CACHE_REFRESH_TIMEOUT_MS || "", 10) || 2000,
};

export const stationActionConfig = {
  webhookTimeoutMs: parseInt(process.env.STATION_ACTION_WEBHOOK_TIMEOUT_MS || "", 10) || 5000,
};

if (!env.isDevelopment && !processorConfig.sharedSecret) {
  throw new Error("PROCESSOR_SHARED_SECRET is required in non-development environments");
}

// Re-exported from the shared runtime package.
export { bullmqConfig } from "@rw/infra/bullmq-config";

export const gatewayMqttConfig = {
  mqttUrl: process.env.MQTT_GATEWAY_REALY_URL,
  mqttUser: process.env.MQTT_GATEWAY_REALY_USER,
  mqttPassword: process.env.MQTT_GATEWAY_REALY_PASSWORD,
};

export const storageConfig = {
  bucketName: process.env.BUCKET_NAME || "",
  region: process.env.AWS_REGION || "auto",
  endpoint: process.env.AWS_ENDPOINT_URL_S3 || "https://fly.storage.tigris.dev",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  enabled: !!process.env.BUCKET_NAME,

  // Limits
  maxFileSizeBytes: 5 * 1024 * 1024, // 5MB
  maxPicturesPerProduct: 10,
  allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"],

  // URL expiry
  presignedUrlExpirySeconds: 3600, // 1 hour
};
