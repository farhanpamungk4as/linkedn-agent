import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fixture } from "./fixture.js";
import { MockBrowserWorker, type BrowserWorker } from "../src/browser/worker.js";
import { PlaywrightBrowserWorker, resolveCdpUrl } from "../src/browser/playwright-worker.js";
import { BrowserActionError } from "../src/browser/types.js";
import { inspectProfileSnapshot } from "../src/linkedin/profile.js";
import { inspectConversationSnapshot, parseLinkedInMessageTime } from "../src/linkedin/messaging.js";
import { runProductionOutreach, approveAndSend, prepareFollowUp } from "../src/outreach/production.js";
import { hashPassword, verifyPassword, AuthService } from "../src/auth/service.js";
import { handleApiRequest } from "../src/api/server.js";
import { loadConfig } from "../src/config/index.js";
import { createHermesClient } from "../src/hermes/client.js";
import { handleTelegramCommand } from "../src/telegram/bot.js";
import { runProductionReplyMonitor } from "../src/monitor/production.js";
import { openDatabase, migrateDatabase } from "../src/db/index.js";
import { LeadRepository } from "../src/leads/repository.js";
import { LeadService } from "../src/leads/service.js";
import { TemplateService } from "../src/templates/service.js";
import { PendingActionService } from "../src/outreach/pending.js";

test("Playwright profile and conversation parsing fails closed", () => {
  const lead = { name: "Jane Doe", linkedin_url: "https://www.linkedin.com/in/jane-doe/" };
  assert.equal(inspectProfileSnapshot({ url: lead.linkedin_url, heading: "Jane Doe", bodyStart: "Experience" }, lead).verified, true);
  assert.throws(() => inspectProfileSnapshot({ url: "https://www.linkedin.com/checkpoint/", heading: null, bodyStart: "Verify your identity" }, lead),
    (error: unknown) => error instanceof BrowserActionError && error.kind === "auth_challenge");
  assert.throws(() => inspectProfileSnapshot({ url: lead.linkedin_url, heading: "Join LinkedIn", bodyStart: "Join LinkedIn or sign in to LinkedIn" }, lead),
    (error: unknown) => error instanceof BrowserActionError && error.kind === "auth_challenge");
  assert.throws(() => inspectProfileSnapshot({ url: lead.linkedin_url, heading: "Other Person", bodyStart: "Experience" }, lead),
    (error: unknown) => error instanceof BrowserActionError && error.kind === "profile_mismatch");
  assert.throws(() => inspectProfileSnapshot({ url: lead.linkedin_url, heading: null, bodyStart: "Experience" }, lead),
    (error: unknown) => error instanceof BrowserActionError && error.kind === "unknown_layout");
  const sentAt = "2026-01-01T00:00:00.000Z";
  const snapshot = { resolved: true, emptyIndicator: false, recipientName: "Jane Doe", messages: [
    { direction: "outgoing" as const, text: "Hello", sentAt },
    { direction: "incoming" as const, text: "Hi", sentAt: "2026-01-02T00:00:00.000Z" },
  ] };
  const inspection = inspectConversationSnapshot(snapshot, sentAt);
  assert.equal(inspection.exists, true);
  assert.equal(inspection.previousOutreach, true);
  assert.equal(inspection.repliedAfterSent, true);
  assert.equal(inspection.reply?.text, "Hi");
  const preparation = inspectConversationSnapshot({ ...snapshot, messages: [{ direction: "unknown", text: "Existing", sentAt: null }] }, null);
  assert.equal(preparation.exists, true);
  assert.equal(preparation.previousOutreach, false);
  assert.equal(preparation.repliedAfterSent, false);
  assert.throws(() => inspectConversationSnapshot({ ...snapshot, messages: [{ direction: "unknown", text: "Hi", sentAt }] }, sentAt), /sender/);
  assert.throws(() => inspectConversationSnapshot({ ...snapshot, messages: [{ direction: "incoming", text: "Hi", sentAt: null }] }, sentAt), /time/);
});

test("reply in the same displayed minute is detected from conversation order", () => {
  const sentAt = "2026-10-06T07:57:39.773Z";
  const result = inspectConversationSnapshot({ resolved: true, emptyIndicator: false, recipientName: "Jane Doe", messages: [
    { direction: "outgoing", text: "Hello", sentAt: "2026-10-06T07:57:00.000Z" },
    { direction: "incoming", text: "Hi", sentAt: "2026-10-06T07:57:00.000Z" },
  ] }, sentAt);
  assert.equal(result.repliedAfterSent, true);
  assert.equal(result.reply?.text, "Hi");
});

test("LinkedIn message labels are converted to timezone-aware timestamps", () => {
  const now = new Date("2026-10-06T08:00:00.000Z"); // 15:00 in Asia/Jakarta.
  assert.equal(parseLinkedInMessageTime("Today", "2:57 PM", now, "Asia/Jakarta"), "2026-10-06T07:57:00.000Z");
  assert.equal(parseLinkedInMessageTime("Yesterday", "9:10 AM", now, "Asia/Jakarta"), "2026-10-05T02:10:00.000Z");
  assert.equal(parseLinkedInMessageTime("Saturday", "10:30 PM", now, "Asia/Jakarta"), "2026-10-03T15:30:00.000Z");
  assert.equal(parseLinkedInMessageTime("Sep 28", "9:57 AM", now, "Asia/Jakarta"), "2026-09-28T02:57:00.000Z");
  assert.equal(parseLinkedInMessageTime("Not a date", "9:57 AM", now, "Asia/Jakarta"), null);
  assert.equal(parseLinkedInMessageTime("Today", "25:00", now, "Asia/Jakarta"), null);
});

test("Playwright worker reports offline without CDP and never creates a profile", async () => {
  const f = fixture();
  try {
    const worker = new PlaywrightBrowserWorker(undefined, f.logger);
    assert.deepEqual(await worker.healthCheck(), { type: "playwright", online: false, detail: "CDP unavailable" });
    await assert.rejects(worker.connect(), (error: unknown) => error instanceof BrowserActionError && error.kind === "browser_offline");
  } finally { f.db.close(); }
});

test("CDP Docker hostname resolves to IP for Chromium Host validation", async () => {
  const resolveHost = async (host: string) => {
    assert.equal(host, "browser");
    return { address: "172.23.0.3", family: 4 };
  };
  assert.equal(await resolveCdpUrl("http://browser:9223", resolveHost), "http://172.23.0.3:9223/");
  assert.equal(await resolveCdpUrl("http://127.0.0.1:9222", resolveHost), "http://127.0.0.1:9222");
  assert.equal(await resolveCdpUrl("https://browser:9223", resolveHost), "https://browser:9223");
});

test("browser disconnect and recovery each notify once", async () => {
  const f = fixture();
  try {
    let online = false;
    const worker = Object.assign(new MockBrowserWorker(f.logger), {
      type: "playwright" as const,
      async healthCheck() { return { type: "playwright" as const, online, detail: online ? "connected" : "offline" }; },
    }) as unknown as BrowserWorker;
    const scheduler = f.scheduler(worker);
    assert.equal((await scheduler.run("outreach")).reason, "Browser offline");
    assert.equal((await scheduler.run("outreach")).reason, "Browser offline");
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0]!, /terputus/);
    online = true;
    await scheduler.run("outreach");
    assert.equal(f.notices.length, 2);
    assert.match(f.notices[1]!, /terhubung kembali/);
    await scheduler.shutdown();
  } finally { f.db.close(); }
});

test("manual mode prepares once and only human confirmation marks SENT", async () => {
  const f = fixture();
  try {
    f.config.outreachMode = "manual";
    const lead = f.createLead(); f.approve(lead.id);
    const worker = new MockBrowserWorker(f.logger);
    assert.deepEqual(await runProductionOutreach(f.config, f.system, f.leads, f.templates, f.pending, worker, f.notifier, f.logger),
      { prepared: 1, failed: 0, limitReached: false });
    assert.equal(f.leads.getById(lead.id)?.status, "APPROVED");
    assert.equal(f.pending.get(lead.id)?.state, "PREPARED");
    assert.equal(f.pending.get(lead.id)?.message, "Hi Jane at Acme (Director)");
    assert.equal((await runProductionOutreach(f.config, f.system, f.leads, f.templates, f.pending, worker, f.notifier, f.logger)).prepared, 0);
    f.pending.markSent(lead.id, true);
    assert.equal(f.leads.getById(lead.id)?.status, "SENT");
    assert.throws(() => f.pending.markSent(lead.id, true), /already been sent/);
    assert.equal(f.pending.correctManualNotSent(lead.id).status, "APPROVED");
    assert.equal(f.leads.getById(lead.id)?.sent_at, null);
    assert.equal(f.pending.get(lead.id)?.state, "CANCELLED");
    f.config.outreachMode = "approval";
    assert.equal((await runProductionOutreach(f.config, f.system, f.leads, f.templates, f.pending, worker, f.notifier, f.logger)).prepared, 1);
    assert.equal(f.pending.get(lead.id)?.mode, "approval");
    assert.equal(f.pending.get(lead.id)?.state, "PREPARED");
  } finally { f.db.close(); }
});

test("approval mode sends only after explicit approval and enforces daily limit", async () => {
  const f = fixture();
  try {
    f.config.outreachMode = "approval";
    f.config.outreachDailyLimit = 1;
    const a = f.createLead(); f.approve(a.id);
    const b = f.leads.create({ name: "Sam", linkedin_url: "https://www.linkedin.com/in/sam/", template_id: f.template.id }); f.approve(b.id);
    const worker = new MockBrowserWorker(f.logger);
    assert.equal((await runProductionOutreach(f.config, f.system, f.leads, f.templates, f.pending, worker, f.notifier, f.logger)).prepared, 2);
    assert.equal(f.leads.getById(a.id)?.status, "APPROVED");
    assert.deepEqual(await approveAndSend(a.id, f.config, f.system, f.leads, f.pending, worker, f.notifier, f.logger), { status: "sent" });
    assert.equal(f.leads.getById(a.id)?.status, "SENT");
    await assert.rejects(approveAndSend(b.id, f.config, f.system, f.leads, f.pending, worker, f.notifier, f.logger), /Daily outreach limit/);
    assert.equal(f.pending.get(b.id)?.state, "PREPARED");
    assert.equal((await runProductionOutreach(f.config, f.system, f.leads, f.templates, f.pending, worker, f.notifier, f.logger)).limitReached, true);
  } finally { f.db.close(); }
});

test("sent lead can prepare and explicitly send a follow-up", async () => {
  const f = fixture();
  try {
    f.config.outreachMode = "approval";
    const lead = f.createLead(); f.approve(lead.id);
    const worker = new MockBrowserWorker(f.logger);
    await runProductionOutreach(f.config, f.system, f.leads, f.templates, f.pending, worker, f.notifier, f.logger);
    await approveAndSend(lead.id, f.config, f.system, f.leads, f.pending, worker, f.notifier, f.logger);
    assert.equal(f.leads.getById(lead.id)?.status, "SENT");
    const followUp = await prepareFollowUp(lead.id, f.config, f.system, f.leads, f.templates,
      f.pending, worker, f.notifier, f.logger);
    assert.equal(followUp.kind, "follow_up");
    assert.equal(followUp.state, "PREPARED");
    assert.equal(f.leads.getById(lead.id)?.status, "APPROVED");
    assert.deepEqual(await approveAndSend(lead.id, f.config, f.system, f.leads, f.pending, worker, f.notifier, f.logger), { status: "sent" });
    assert.equal(f.leads.getById(lead.id)?.status, "SENT");
  } finally { f.db.close(); }
});

test("pause and kill switch block all browser work", async () => {
  const f = fixture();
  try {
    const lead = f.createLead(); f.approve(lead.id);
    const worker = new MockBrowserWorker(f.logger);
    f.config.automationEnabled = false;
    assert.equal((await f.scheduler().run("outreach")).reason, "AUTOMATION_ENABLED=false");
    assert.equal((await runProductionOutreach(f.config, f.system, f.leads, f.templates, f.pending, worker, f.notifier, f.logger)).prepared, 0);
    f.config.automationEnabled = true;
    f.system.setPaused(true);
    assert.equal((await runProductionOutreach(f.config, f.system, f.leads, f.templates, f.pending, worker, f.notifier, f.logger)).prepared, 0);
    assert.equal(f.leads.getById(lead.id)?.status, "APPROVED");
  } finally { f.db.close(); }
});

test("browser offline retries are bounded; auth challenge and unknown layout require human", async () => {
  for (const kind of ["browser_offline", "auth_challenge", "unknown_layout"] as const) {
    const f = fixture();
    try {
      const lead = f.createLead(); f.approve(lead.id);
      const worker: BrowserWorker = Object.assign(new MockBrowserWorker(f.logger), {
        async prepareOutreach() { throw new BrowserActionError(kind, `${kind} fixture`); },
      });
      const attempts = kind === "browser_offline" ? 3 : 1;
      for (let i = 0; i < attempts; i++) {
        await runProductionOutreach(f.config, f.system, f.leads, f.templates, f.pending, worker, f.notifier, f.logger);
      }
      assert.equal(f.leads.getById(lead.id)?.status, "FAILED");
      assert.equal(f.leads.getById(lead.id)?.error_class, kind);
      assert.equal(f.leads.getById(lead.id)?.outreach_attempts, attempts);
      if (kind === "auth_challenge") assert.ok(f.notices.some((notice) => notice.includes("LinkedIn meminta login")));
      if (kind !== "browser_offline") assert.equal(f.leads.retry(lead.id).status, "APPROVED");
    } finally { f.db.close(); }
  }
});

test("uncertain send is never retried automatically", async () => {
  const f = fixture();
  try {
    f.config.outreachMode = "approval";
    const lead = f.createLead(); f.approve(lead.id);
    f.leads.claimOutreach(lead.id);
    f.pending.prepare(lead.id, "approval", { profileUrl: lead.linkedin_url, profileName: lead.name, message: "Hi Jane" });
    const worker = Object.assign(new MockBrowserWorker(f.logger), { async sendApprovedOutreach() { return { status: "uncertain" as const }; } });
    assert.deepEqual(await approveAndSend(lead.id, f.config, f.system, f.leads, f.pending, worker, f.notifier, f.logger), { status: "uncertain" });
    assert.equal(f.pending.get(lead.id)?.state, "UNCERTAIN");
    await assert.rejects(approveAndSend(lead.id, f.config, f.system, f.leads, f.pending, worker, f.notifier, f.logger), /No approved pending/);
    assert.equal(f.leads.getById(lead.id)?.status, "APPROVED");
  } finally { f.db.close(); }
});

test("SENDING reservation survives restart and blocks duplicate approval", () => {
  const dir = mkdtempSync(join(tmpdir(), "linkedin-agent-restart-"));
  const path = join(dir, "leads.db");
  const db = openDatabase(path);
  try {
    migrateDatabase(db);
    const leads = new LeadService(new LeadRepository(db));
    const template = new TemplateService(db).create({ name: "Intro", body: "Hi {{name}}" });
    const pending = new PendingActionService(db, "Asia/Jakarta");
    const lead = leads.create({ name: "Jane Doe", linkedin_url: "https://www.linkedin.com/in/jane-doe/", template_id: template.id });
    leads.updateStatus(lead.id, "QUALIFIED"); leads.approve(lead.id); leads.claimOutreach(lead.id);
    pending.prepare(lead.id, "approval", { profileUrl: lead.linkedin_url, profileName: lead.name, message: "Hi Jane Doe" });
    pending.reserveSend(lead.id, 20);
    db.close();
    const reopened = openDatabase(path);
    try {
      migrateDatabase(reopened);
      const afterRestart = new PendingActionService(reopened, "Asia/Jakarta");
      assert.equal(afterRestart.get(lead.id)?.state, "SENDING");
      assert.throws(() => afterRestart.reserveSend(lead.id, 20), /No approved pending action/);
      assert.equal(new LeadRepository(reopened).getById(lead.id)?.status, "APPROVED");
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reply monitor errors stop safely and can be explicitly reset", async () => {
  const f = fixture();
  try {
    const lead = f.createLead(); f.approve(lead.id);
    f.leads.claimOutreach(lead.id);
    f.pending.prepare(lead.id, "manual", { profileUrl: lead.linkedin_url, profileName: lead.name, message: "Hi" });
    f.pending.markSent(lead.id, true);
    const worker = Object.assign(new MockBrowserWorker(f.logger), {
      async checkReplyStatus() { throw new BrowserActionError("temporary_navigation", "Navigation failed"); },
    });
    for (let i = 0; i < 3; i++) await runProductionReplyMonitor(f.config, f.system, f.leads, worker, f.notifier, f.logger);
    assert.equal(f.leads.getById(lead.id)?.monitor_failures, 3);
    assert.equal((await runProductionReplyMonitor(f.config, f.system, f.leads, worker, f.notifier, f.logger)).failed, 0);
    f.leads.retry(lead.id);
    assert.equal(f.leads.getById(lead.id)?.monitor_failures, 0);
    const layoutWorker = Object.assign(new MockBrowserWorker(f.logger), {
      async checkReplyStatus() { throw new BrowserActionError("unknown_layout", "Layout changed"); },
    });
    await runProductionReplyMonitor(f.config, f.system, f.leads, layoutWorker, f.notifier, f.logger);
    assert.equal(f.leads.getById(lead.id)?.monitor_failures, 3);
    f.leads.retry(lead.id);
    assert.equal(f.leads.getById(lead.id)?.monitor_failures, 0);
  } finally { f.db.close(); }
});

test("reply after outreach triggers notification and human takeover", async () => {
  const f = fixture();
  try {
    const lead = f.createLead(); f.approve(lead.id);
    f.leads.claimOutreach(lead.id);
    f.pending.prepare(lead.id, "manual", { profileUrl: lead.linkedin_url, profileName: lead.name, message: "Hi" });
    f.pending.markSent(lead.id, true);
    let replyButtons: unknown;
    const result = await runProductionReplyMonitor(
      { ...f.config, publicUrl: "https://203.0.113.10" }, f.system, f.leads, new MockBrowserWorker(f.logger),
      { async notify(message, options) { f.notices.push(message); replyButtons = options?.buttons; } }, f.logger,
    );
    assert.deepEqual(result, { replied: 1, checked: 1, failed: 0 });
    const updated = f.leads.getById(lead.id)!;
    assert.equal(updated.status, "HUMAN_TAKEOVER");
    assert.ok(updated.replied_at);
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0]!, /Balasan dari Jane Doe/);
    assert.match(f.notices[0]!, /Mock reply/);
    assert.equal((replyButtons as { text: string }[][])[1]?.[1]?.text, "Mark Handled");
    assert.equal(f.leads.conversation(lead.id).some((message) => message.direction === "outgoing" && message.body === "Hi"), true);
    assert.equal(f.leads.conversation(lead.id).some((message) => message.direction === "incoming" && message.body === "Mock reply"), true);
    assert.ok(f.leads.markHumanHandled(lead.id).human_handled_at);
    f.leads.recordConversationMessage(lead.id, "incoming", "A newer reply", new Date(Date.now() + 60_000).toISOString(), "linkedin");
    assert.equal(f.leads.getById(lead.id)?.human_handled_at, null);
    assert.equal((f.leads.getByStatus("SENT")).length, 0);
  } finally { f.db.close(); }
});

test("Telegram pending approval obeys allowed user and sends exactly once", async () => {
  const f = fixture();
  try {
    const lead = f.createLead(); f.approve(lead.id); f.leads.claimOutreach(lead.id);
    f.pending.prepare(lead.id, "approval", { profileUrl: lead.linkedin_url, profileName: lead.name, message: "Hi" });
    let sends = 0;
    const extras = { pending: f.pending, approveAndSend: async () => { sends++; return { status: "sent" }; } };
    const msg = (id: number) => ({ text: `/approve ${lead.id}`, chat: { id }, from: { id } });
    assert.equal(await handleTelegramCommand(msg(99), "42", f.leads, f.system, f.notifier, extras), null);
    assert.equal(sends, 0);
    assert.match((await handleTelegramCommand(msg(42), "42", f.leads, f.system, f.notifier, extras))!, /Send result: sent/);
    assert.equal(sends, 1);
  } finally { f.db.close(); }
});

test("dashboard API auth protects data and mutations with secure session and CSRF", async () => {
  const f = fixture();
  try {
    const hash = hashPassword("a strong local admin password", "00112233445566778899aabbccddeeff");
    assert.equal(verifyPassword("a strong local admin password", hash), true);
    assert.equal(verifyPassword("wrong password", hash), false);
    const config = loadConfig({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD_HASH: hash, SESSION_SECRET: "0123456789abcdef0123456789abcdef" });
    const auth = new AuthService(config);
    const context = { config, auth, leads: f.leads, templates: f.templates, system: f.system, scheduler: f.scheduler(), notifier: f.notifier, logger: f.logger };
    async function call(path: string, method = "GET", value?: unknown, cookie?: string, csrf?: string) {
      const request = Readable.from(value === undefined ? [] : [JSON.stringify(value)]) as IncomingMessage;
      request.url = `/api${path}`; request.method = method;
      request.headers = { ...(value === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) };
      let status = 200; let output = ""; let setCookie = "";
      const response = { writeHead(code: number) { status = code; return this; }, setHeader(key: string, val: string) {
        if (key === "Set-Cookie") setCookie = val; return this; }, end(data?: string) { output = data ?? ""; } } as unknown as ServerResponse;
      await handleApiRequest(request, response, context);
      return { status, data: JSON.parse(output), cookie: setCookie };
    }
    assert.equal((await call("/health")).status, 200);
    assert.equal((await call("/leads")).status, 401);
    assert.equal((await call("/auth/login", "POST", { username: "admin", password: "wrong password" })).status, 401);
    const login = await call("/auth/login", "POST", { username: "admin", password: "a strong local admin password" });
    assert.equal(login.status, 200);
    assert.match(login.cookie, /HttpOnly; SameSite=Strict/);
    const cookie = login.cookie.split(";")[0];
    assert.equal((await call("/leads", "GET", undefined, cookie)).status, 200);
    assert.equal((await call("/system/pause", "POST", undefined, cookie)).status, 403);
    assert.equal((await call("/system/pause", "POST", undefined, cookie, login.data.csrf_token)).status, 200);
    assert.equal((await call("/auth/logout", "POST", undefined, cookie, login.data.csrf_token)).status, 200);
    assert.equal((await call("/leads", "GET", undefined, cookie)).status, 401);
  } finally { f.db.close(); }
});

test("Hermes disabled never calls an external service", async () => {
  const client = createHermesClient(loadConfig({ HERMES_ENABLED: "false" }));
  assert.equal(client.enabled, false);
  assert.deepEqual(await client.healthCheck(), { online: false, detail: "disabled" });
});
