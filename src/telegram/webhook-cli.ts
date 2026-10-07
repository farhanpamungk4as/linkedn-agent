import "dotenv/config";
import { loadConfig } from "../config/index.js";

const action = process.argv[2];
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!["set", "info", "delete"].includes(action ?? "")) {
  throw new Error("Usage: npm run telegram:webhook -- set|info|delete");
}

let method: string;
let payload: Record<string, unknown> | undefined;
if (action === "set") {
  const config = loadConfig();
  if (config.telegramMode !== "webhook" || !config.telegramWebhookUrl || !config.telegramWebhookSecret) {
    throw new Error("Set TELEGRAM_MODE=webhook, TELEGRAM_WEBHOOK_URL, and TELEGRAM_WEBHOOK_SECRET first");
  }
  method = "setWebhook";
  payload = { url: config.telegramWebhookUrl, secret_token: config.telegramWebhookSecret,
    allowed_updates: ["message", "callback_query"], max_connections: 1, drop_pending_updates: false };
} else if (action === "delete") {
  method = "deleteWebhook";
  payload = { drop_pending_updates: false };
} else {
  method = "getWebhookInfo";
}

const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: payload ? "POST" : "GET",
  ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}),
});
const data = await response.json() as { ok?: boolean; description?: string;
  result?: { url?: string; pending_update_count?: number; last_error_message?: string } | boolean };
if (!response.ok || !data.ok) throw new Error(data.description ?? `Telegram HTTP ${response.status}`);
if (action === "info") {
  const info = data.result as Exclude<typeof data.result, boolean>;
  console.log(JSON.stringify({ url: info?.url, pendingUpdates: info?.pending_update_count,
    lastError: info?.last_error_message }, null, 2));
} else {
  console.log(action === "set" ? "Webhook registered. Check with npm run telegram:webhook -- info" : "Webhook removed. Polling can be started again.");
}
