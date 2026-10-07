import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fixture } from "./fixture.js";
import { parseCommand, handleTelegramCommand, TelegramBot, TELEGRAM_COMMANDS } from "../src/telegram/bot.js";
import { handleApiRequest, webhookSecretValid } from "../src/api/server.js";
import { loadConfig } from "../src/config/index.js";
import { replyButtons } from "../src/monitor/production.js";
import { TelegramNotifier } from "../src/telegram/notifier.js";

test("Telegram parser blocks unknown user and supports approval, rejection, status, pause, resume", async () => {
  const f = fixture();
  try {
    assert.deepEqual(parseCommand("/approve abc"), { command: "approve", argument: "abc" });
    assert.equal(parseCommand("hello"), null);
    const lead = f.createLead(); f.leads.updateStatus(lead.id, "QUALIFIED");
    assert.equal(await handleTelegramCommand({ text: `/approve ${lead.id}`, chat: { id: 999 }, from: { id: 999 } }, "42", f.leads, f.system, f.notifier), null);
    assert.equal(f.leads.getById(lead.id)?.status, "QUALIFIED");
    const send = (text: string) => handleTelegramCommand({ text, chat: { id: 42 }, from: { id: 42 } }, "42", f.leads, f.system, f.notifier);
    assert.match((await send(`/approve ${lead.id}`))!, /Approved/);
    assert.equal(f.leads.getById(lead.id)?.status, "APPROVED");
    assert.match((await send("/status"))!, /Approved: 1/);
    assert.match((await send(`/lead ${lead.id}`))!, /Jane Doe/);
    const other = f.leads.create({ name: "Sam", linkedin_url: "https://www.linkedin.com/in/sam/" });
    assert.match((await send(`/reject ${other.id}`))!, /Skipped/);
    assert.equal(f.leads.getById(other.id)?.status, "SKIPPED");
    await send("/pause"); assert.equal(f.system.getSettings().paused, true);
    await send("/resume"); assert.equal(f.system.getSettings().paused, false);
  } finally { f.db.close(); }
});

test("Telegram human takeover commands show replies, sync, and mark handled", async () => {
  const f = fixture();
  try {
    assert.deepEqual(parseCommand("/sync abc"), { command: "sync", argument: "abc" });
    assert.deepEqual(parseCommand("/handled abc"), { command: "handled", argument: "abc" });
    const lead = f.createLead(); f.approve(lead.id); f.leads.claimOutreach(lead.id);
    f.pending.prepare(lead.id, "manual", { profileUrl: lead.linkedin_url, profileName: lead.name, message: "Hello" });
    f.pending.markSent(lead.id, true);
    f.leads.updateStatus(lead.id, "REPLIED");
    f.leads.updateStatus(lead.id, "HUMAN_TAKEOVER");
    f.leads.recordConversationMessage(lead.id, "incoming", "Interested, tell me more", new Date().toISOString(), "linkedin");
    let syncs = 0;
    const send = (text: string) => handleTelegramCommand(
      { text, chat: { id: 42 }, from: { id: 42 } }, "42", f.leads, f.system, f.notifier,
      { dashboardBaseUrl: "http://127.0.0.1:3000", async syncConversation() {
        syncs++; return { newMessages: 0, newIncoming: 0, status: "HUMAN_TAKEOVER" };
      } },
    );
    assert.match((await send("/replies"))!, /Interested, tell me more/);
    assert.match((await send(`/lead ${lead.id}`))!, /Last reply: Interested/);
    assert.match((await send(`/sync ${lead.id}`))!, /Sync complete/);
    assert.equal(syncs, 1);
    assert.match((await send(`/handled ${lead.id}`))!, /Handled/);
    assert.ok(f.leads.getById(lead.id)?.human_handled_at);
    assert.match((await send("/help"))!, /\/sync <id>/);
  } finally { f.db.close(); }
});

test("API validates inputs and completes the mock workflow", async () => {
  const f = fixture();
  const context = { config: f.config, leads: f.leads, templates: f.templates,
    system: f.system, scheduler: f.scheduler(), notifier: f.notifier, logger: f.logger };
  async function call(path: string, method = "GET", value?: unknown): Promise<{ status: number; data: any }> {
    const request = Readable.from(value === undefined ? [] : [JSON.stringify(value)]) as IncomingMessage;
    request.url = `/api${path}`;
    request.method = method;
    request.headers = value === undefined ? {} : { "content-type": "application/json" };
    let status = 200;
    let output = "";
    const response = {
      writeHead(code: number) { status = code; return this; },
      end(data?: string) { output = data ?? ""; },
    } as unknown as ServerResponse;
    await handleApiRequest(request, response, context);
    return { status, data: JSON.parse(output) };
  }
  try {
    assert.equal((await call("/health")).status, 200);
    assert.equal((await call("/leads", "POST", { name: "Bad", linkedin_url: "http://example.com" })).status, 400);
    const response = await call("/leads", "POST", { name: "API Lead", linkedin_url: "https://www.linkedin.com/in/api-lead/", template_id: f.template.id });
    assert.equal(response.status, 201);
    const lead = response.data as { id: string };
    assert.equal((await call(`/leads/${lead.id}`, "PATCH", { score: 82, job_title: "Founder" })).status, 200);
    const createdTemplate = await call("/templates", "POST", { name: "Follow-up", body: "Hello {{name}}" });
    assert.equal(createdTemplate.status, 201);
    const templateId = createdTemplate.data.id as string;
    assert.equal((await call(`/templates/${templateId}`, "PATCH", { body: "Hi {{first_name}}" })).status, 200);
    assert.equal((await call(`/templates/${templateId}`, "DELETE")).status, 200);
    assert.equal((await call(`/leads/${lead.id}/approve`, "POST")).status, 409);
    assert.equal((await call(`/leads/${lead.id}/qualify`, "POST")).status, 200);
    assert.equal((await call(`/leads/${lead.id}/approve`, "POST")).status, 200);
    const list = (await call("/leads?status=APPROVED&search=API&page=1&page_size=10")).data as { total: number };
    assert.equal(list.total, 1);
    assert.equal((await call("/system/settings", "PATCH", { outreach_enabled: false, monitor_enabled: "invalid" })).status, 400);
    assert.equal(f.system.getSettings().outreach_enabled, true);
    await call("/system/pause", "POST");
    const paused = (await call("/jobs/outreach/run", "POST")).data as { status: string };
    assert.equal(paused.status, "skipped");
    await call("/system/resume", "POST");
    const outreach = (await call("/jobs/outreach/run", "POST")).data as { result: { sent: number } };
    assert.equal(outreach.result.sent, 1);
    const replies = (await call("/jobs/replies/run", "POST")).data as { result: { handoffs: number } };
    assert.equal(replies.result.handoffs, 1);
    const detail = (await call(`/leads/${lead.id}`)).data as { status: string; activity: unknown[] };
    assert.equal(detail.status, "HUMAN_TAKEOVER");
    assert.ok(detail.activity.length >= 5);
    assert.equal((await call("/templates/preview", "POST", { body: "Hi {{name}}", values: { name: "API Lead" } })).status, 200);
    assert.equal((await call("/leads?status=BAD")).status, 400);
  } finally { f.db.close(); }
});

test("webhook validates Telegram secret before dispatching, even without dashboard session", async () => {
  const f = fixture();
  try {
    const config = loadConfig({ TELEGRAM_MODE: "webhook", TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_ALLOWED_USER_ID: "42",
      TELEGRAM_WEBHOOK_SECRET: "secret_1234567890123456", TELEGRAM_WEBHOOK_URL: "https://203.0.113.10/api/telegram/webhook" });
    const updates: number[] = [];
    const context = { config, leads: f.leads, templates: f.templates, system: f.system,
      scheduler: f.scheduler(), notifier: f.notifier, logger: f.logger,
      telegramBot: { async handleUpdate(update: { update_id: number }) { updates.push(update.update_id); } } as TelegramBot };
    async function call(secret?: string, update: unknown = { update_id: 101 }) {
      const request = Readable.from([JSON.stringify(update)]) as IncomingMessage;
      request.url = "/api/telegram/webhook"; request.method = "POST";
      request.headers = { "content-type": "application/json", ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}) };
      let status = 200;
      const response = { writeHead(code: number) { status = code; return this; }, end() {} } as unknown as ServerResponse;
      await handleApiRequest(request, response, context);
      return status;
    }
    assert.equal(webhookSecretValid("secret_1234567890123456", config.telegramWebhookSecret), true);
    assert.equal(await call(), 403);
    assert.equal(await call("wrong"), 403);
    assert.equal(await call(config.telegramWebhookSecret, { update_id: "bad" }), 400);
    assert.equal(updates.length, 0);
    assert.equal(await call(config.telegramWebhookSecret), 200);
    assert.deepEqual(updates, [101]);
  } finally { f.db.close(); }
});

test("reply buttons serialize and callbacks only act for the allowed user", async () => {
  const f = fixture();
  const previousFetch = globalThis.fetch;
  const calls: { method: string; body: Record<string, any> }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ method: String(input).split("/").at(-1)!, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  };
  try {
    const lead = f.createLead(); f.approve(lead.id); f.leads.claimOutreach(lead.id);
    f.pending.prepare(lead.id, "manual", { profileUrl: lead.linkedin_url, profileName: lead.name, message: "Hello" });
    f.pending.markSent(lead.id, true);
    f.leads.updateStatus(lead.id, "REPLIED");
    f.leads.updateStatus(lead.id, "HUMAN_TAKEOVER");
    f.leads.setConversationUrl(lead.id, "https://www.linkedin.com/messaging/thread/abc/");
    const buttons = replyButtons(f.leads.getById(lead.id)!, "https://203.0.113.10");
    await new TelegramNotifier("test-token", "42").notify("Balasan dari Jane Doe: hello", { buttons });
    assert.equal(calls[0]?.method, "sendMessage");
    assert.equal(calls[0]?.body.reply_markup.inline_keyboard[0][0].text, "Open LinkedIn");
    assert.equal(calls[0]?.body.reply_markup.inline_keyboard[0][1].text, "View Lead");
    assert.equal(calls[0]?.body.reply_markup.inline_keyboard[1][0].callback_data, `sync:${lead.id}`);
    assert.equal(calls[0]?.body.reply_markup.inline_keyboard[1][1].callback_data, `handled:${lead.id}`);
    const bot = new TelegramBot("test-token", "42", f.leads, f.system, f.notifier, f.logger);
    await bot.handleUpdate({ update_id: 1, callback_query: { id: "unauthorized", from: { id: 99 }, data: `handled:${lead.id}`, message: { chat: { id: 99 } } } });
    assert.equal(f.leads.getById(lead.id)?.human_handled_at, null);
    await bot.handleUpdate({ update_id: 2, callback_query: { id: "authorized", from: { id: 42 }, data: `handled:${lead.id}`, message: { chat: { id: 42 } } } });
    assert.ok(f.leads.getById(lead.id)?.human_handled_at);
    assert.equal(calls.filter((call) => call.method === "answerCallbackQuery").length, 2);
    assert.equal(calls.filter((call) => call.method === "sendMessage").length, 2);
    assert.ok(TELEGRAM_COMMANDS.some((command) => command.command === "status"));
  } finally { globalThis.fetch = previousFetch; f.db.close(); }
});
