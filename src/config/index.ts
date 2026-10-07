import "dotenv/config";
import { resolve } from "node:path";

export interface AppConfig {
  databasePath: string;
  appPort: number;
  appHost: string;
  timezone: string;
  logLevel: "debug" | "info" | "warn" | "error";
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramAllowedUserId?: string;
  telegramMode: "polling" | "webhook";
  telegramWebhookSecret?: string;
  telegramWebhookUrl?: string;
  publicUrl?: string;
  outreachInterval: number;
  replyMonitorInterval: number;
  outreachEnabled: boolean;
  monitorEnabled: boolean;
  automationEnabled: boolean;
  browserWorker: "mock" | "playwright";
  browserCdpUrl?: string;
  outreachMode: "manual" | "approval";
  outreachDailyLimit: number;
  adminUsername?: string;
  adminPasswordHash?: string;
  sessionSecret?: string;
  cookieSecure: boolean;
  hermesEnabled: boolean;
  hermesBaseUrl?: string;
  hermesApiKey?: string;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}

function bool(value: string | undefined, fallback: boolean, name: string): boolean {
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const logLevel = env.LOG_LEVEL || "info";
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  }

  const appPort = positiveInt(env.APP_PORT, 3000, "APP_PORT");
  if (appPort > 65535) throw new Error("APP_PORT must be at most 65535");
  const timezone = env.APP_TIMEZONE || "Asia/Jakarta";
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); }
  catch { throw new Error("APP_TIMEZONE must be a valid IANA timezone"); }
  if (env.TELEGRAM_ALLOWED_USER_ID && !/^\d+$/.test(env.TELEGRAM_ALLOWED_USER_ID)) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID must be numeric");
  }
  const telegramMode = env.TELEGRAM_MODE || "polling";
  if (telegramMode !== "polling" && telegramMode !== "webhook") throw new Error("TELEGRAM_MODE must be polling or webhook");
  if (telegramMode === "webhook") {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ALLOWED_USER_ID || !env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_WEBHOOK_URL) {
      throw new Error("Webhook mode requires TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID, TELEGRAM_WEBHOOK_SECRET, and TELEGRAM_WEBHOOK_URL");
    }
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) {
      throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16-256 letters, digits, underscores, or hyphens");
    }
    let webhookUrl: URL;
    try { webhookUrl = new URL(env.TELEGRAM_WEBHOOK_URL); } catch { throw new Error("TELEGRAM_WEBHOOK_URL must be a valid HTTPS URL"); }
    if (webhookUrl.protocol !== "https:" || webhookUrl.pathname !== "/api/telegram/webhook" || webhookUrl.search || webhookUrl.hash || webhookUrl.username || webhookUrl.password) {
      throw new Error("TELEGRAM_WEBHOOK_URL must be https://<public-ip>/api/telegram/webhook");
    }
  }
  const browserWorker = env.BROWSER_WORKER || "mock";
  if (browserWorker !== "mock" && browserWorker !== "playwright") throw new Error("BROWSER_WORKER must be mock or playwright");
  const outreachMode = env.OUTREACH_MODE || "manual";
  if (outreachMode !== "manual" && outreachMode !== "approval") throw new Error("OUTREACH_MODE must be manual or approval");
  const automationEnabled = bool(env.AUTOMATION_ENABLED, browserWorker === "mock", "AUTOMATION_ENABLED");
  if (browserWorker === "playwright" && automationEnabled && !env.BROWSER_CDP_URL) {
    throw new Error("BROWSER_CDP_URL is required when Playwright automation is enabled");
  }
  if (env.BROWSER_CDP_URL && !/^(https?|wss?):\/\//.test(env.BROWSER_CDP_URL)) {
    throw new Error("BROWSER_CDP_URL must be an HTTP or WebSocket URL");
  }
  const appHost = env.APP_HOST || "127.0.0.1";
  const authValues = [env.ADMIN_USERNAME, env.ADMIN_PASSWORD_HASH, env.SESSION_SECRET];
  if (authValues.some(Boolean) && !authValues.every(Boolean)) throw new Error("Set ADMIN_USERNAME, ADMIN_PASSWORD_HASH, and SESSION_SECRET together");
  if ((env.NODE_ENV === "production" || !["127.0.0.1", "localhost", "::1"].includes(appHost)) && !authValues.every(Boolean)) {
    throw new Error("Admin authentication is required outside local development");
  }
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const hermesEnabled = bool(env.HERMES_ENABLED, false, "HERMES_ENABLED");
  if (env.APP_PUBLIC_URL) {
    let publicUrl: URL;
    try { publicUrl = new URL(env.APP_PUBLIC_URL); } catch { throw new Error("APP_PUBLIC_URL must be a valid HTTP(S) URL"); }
    if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password) {
      throw new Error("APP_PUBLIC_URL must be a valid HTTP(S) URL");
    }
  }

  return {
    databasePath: env.DATABASE_PATH === ":memory:" ? ":memory:" : resolve(env.DATABASE_PATH || "./data/leads.db"),
    appPort,
    appHost,
    timezone,
    logLevel: logLevel as AppConfig["logLevel"],
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    telegramAllowedUserId: env.TELEGRAM_ALLOWED_USER_ID || undefined,
    telegramMode,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET || undefined,
    telegramWebhookUrl: env.TELEGRAM_WEBHOOK_URL || undefined,
    publicUrl: env.APP_PUBLIC_URL?.replace(/\/$/, "") || undefined,
    outreachInterval: positiveInt(env.OUTREACH_INTERVAL, 300, "OUTREACH_INTERVAL"),
    replyMonitorInterval: positiveInt(env.REPLY_MONITOR_INTERVAL, 120, "REPLY_MONITOR_INTERVAL"),
    outreachEnabled: bool(env.OUTREACH_ENABLED, true, "OUTREACH_ENABLED"),
    monitorEnabled: bool(env.MONITOR_ENABLED, true, "MONITOR_ENABLED"),
    automationEnabled,
    browserWorker,
    browserCdpUrl: env.BROWSER_CDP_URL || undefined,
    outreachMode,
    outreachDailyLimit: positiveInt(env.OUTREACH_DAILY_LIMIT, 20, "OUTREACH_DAILY_LIMIT"),
    adminUsername: env.ADMIN_USERNAME || undefined,
    adminPasswordHash: env.ADMIN_PASSWORD_HASH || undefined,
    sessionSecret: env.SESSION_SECRET || undefined,
    cookieSecure: bool(env.COOKIE_SECURE, env.NODE_ENV === "production", "COOKIE_SECURE"),
    hermesEnabled,
    hermesBaseUrl: env.HERMES_BASE_URL || undefined,
    hermesApiKey: env.HERMES_API_KEY || undefined,
  };
}
