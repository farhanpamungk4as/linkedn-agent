import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase, migrateDatabase } from "../src/db/index.js";
import { LeadRepository } from "../src/leads/repository.js";
import { renderTemplate, valuesForLead } from "../src/templates/service.js";
import { MockBrowserWorker, type BrowserWorker } from "../src/browser/worker.js";
import { MockReplyDetector, runMockReplyMonitor } from "../src/monitor/workflow.js";
import { runMockOutreach } from "../src/outreach/workflow.js";
import { fixture } from "./fixture.js";

test("v1 database upgrades without losing leads", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`CREATE TABLE leads (id TEXT PRIMARY KEY, name TEXT NOT NULL, linkedin_url TEXT NOT NULL UNIQUE,
      company TEXT, status TEXT NOT NULL, template_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      sent_at TEXT, replied_at TEXT) STRICT;
      INSERT INTO leads VALUES ('old', 'Existing', 'https://www.linkedin.com/in/existing/', NULL, 'NEW', NULL,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL);
      PRAGMA user_version = 1;`);
    migrateDatabase(db);
    assert.equal(new LeadRepository(db).getById("old")?.name, "Existing");
    assert.equal(new LeadRepository(db).getById("old")?.outreach_attempts, 0);
  } finally { db.close(); }
});

test("v2 database upgrades to pending-action schema without losing leads", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`CREATE TABLE leads (id TEXT PRIMARY KEY, name TEXT NOT NULL, linkedin_url TEXT NOT NULL UNIQUE,
      company TEXT, status TEXT NOT NULL, template_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      sent_at TEXT, replied_at TEXT, job_title TEXT, location TEXT, score INTEGER, score_reason TEXT,
      approved_at TEXT, last_checked_at TEXT, error_message TEXT, outreach_claimed_at TEXT,
      outreach_attempts INTEGER NOT NULL DEFAULT 0, monitor_failures INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE activity_logs (id TEXT PRIMARY KEY, lead_id TEXT, event TEXT NOT NULL,
        message TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      INSERT INTO leads (id, name, linkedin_url, status, created_at, updated_at)
        VALUES ('old', 'Existing', 'https://www.linkedin.com/in/existing/', 'NEW',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 2;`);
    migrateDatabase(db);
    migrateDatabase(db);
    assert.equal(new LeadRepository(db).getById("old")?.name, "Existing");
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'pending_actions'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_messages'").get());
    assert.equal(new LeadRepository(db).getById("old")?.human_handled_at, null);
    assert.ok(db.prepare("SELECT kind FROM pending_actions LIMIT 1"));
  } finally { db.close(); }
});

test("state transitions, mock outreach, reply, and duplicate prevention", async () => {
  const f = fixture();
  try {
    const lead = f.createLead();
    assert.throws(() => f.leads.approve(lead.id), /Invalid transition/);
    assert.throws(() => f.leads.updateStatus(lead.id, "SENT"), /Invalid transition/);
    f.approve(lead.id);
    assert.ok(f.leads.getById(lead.id)?.approved_at);
    assert.deepEqual(await runMockOutreach(f.leads, f.templates, new MockBrowserWorker(f.logger), f.notifier, f.logger), { sent: 1, failed: 0 });
    assert.deepEqual(await runMockOutreach(f.leads, f.templates, new MockBrowserWorker(f.logger), f.notifier, f.logger), { sent: 0, failed: 0 });
    assert.equal(f.leads.getById(lead.id)?.outreach_attempts, 1);
    assert.ok(f.leads.getById(lead.id)?.sent_at);
    assert.deepEqual(await runMockReplyMonitor(f.leads, new MockReplyDetector(), f.notifier, f.logger), { replied: 1, handoffs: 1 });
    assert.equal(f.leads.getById(lead.id)?.status, "HUMAN_TAKEOVER");
    assert.ok(f.leads.getById(lead.id)?.replied_at);
    assert.deepEqual(await runMockOutreach(f.leads, f.templates, new MockBrowserWorker(f.logger), f.notifier, f.logger), { sent: 0, failed: 0 });
    assert.throws(() => f.leads.retry(lead.id), /Retry unavailable/);
    assert.throws(() => f.leads.updateStatus(lead.id, "APPROVED"), /Invalid transition/);
    const events = f.leads.activity.list(lead.id).map((item) => item.event);
    for (const event of ["lead_created", "lead_qualified", "approved", "outreach_started", "message_sent", "reply_detected", "human_takeover"]) assert.ok(events.includes(event));
    assert.ok(f.notices.some((message) => message.includes("Automation stopped for this lead")));
  } finally { f.db.close(); }
});

test("REPLIED and HUMAN_TAKEOVER cannot return to outreach", async () => {
  const f = fixture();
  try {
    const lead = f.createLead(); f.approve(lead.id);
    await runMockOutreach(f.leads, f.templates, new MockBrowserWorker(f.logger), f.notifier, f.logger);
    f.leads.updateStatus(lead.id, "REPLIED");
    assert.deepEqual(await runMockOutreach(f.leads, f.templates, new MockBrowserWorker(f.logger), f.notifier, f.logger), { sent: 0, failed: 0 });
    assert.throws(() => f.leads.updateStatus(lead.id, "APPROVED"), /Invalid transition/);
    f.leads.humanTakeover(lead.id);
    assert.deepEqual(await runMockOutreach(f.leads, f.templates, new MockBrowserWorker(f.logger), f.notifier, f.logger), { sent: 0, failed: 0 });
  } finally { f.db.close(); }
});

test("template rendering and CRUD are deterministic", () => {
  const f = fixture();
  try {
    const lead = f.createLead();
    assert.equal(renderTemplate(f.template.body, valuesForLead(lead)), "Hi Jane at Acme (Director)");
    assert.equal(f.templates.preview(f.template.id, { first_name: "Sam", company: "Example", job_title: "CEO" }), "Hi Sam at Example (CEO)");
    assert.throws(() => f.templates.create({ name: "Bad", body: "{{unknown}}" }), /Unknown template/);
    assert.throws(() => f.templates.create({ name: "Bad", body: "{{name}} }}" }), /Malformed template/);
    assert.throws(() => f.templates.delete(f.template.id), /assigned/);
    const other = f.templates.create({ name: "Other", body: "Hello {{name}}" });
    assert.equal(f.leads.patch(lead.id, { template_id: other.id }).template_id, other.id);
    f.templates.delete(f.template.id);
  } finally { f.db.close(); }
});

test("pause/resume and scheduler lock prevent work", async () => {
  const f = fixture();
  try {
    const lead = f.createLead(); f.approve(lead.id);
    const scheduled = f.scheduler();
    scheduled.start();
    assert.equal(scheduled.status().health, "RUNNING");
    assert.ok(scheduled.status().next_run.outreach);
    scheduled.stop();
    f.system.setPaused(true);
    assert.equal((await f.scheduler().run("outreach")).status, "skipped");
    assert.equal((await f.scheduler().run("replies")).status, "skipped");
    assert.equal(f.leads.getById(lead.id)?.status, "APPROVED");
    f.system.setPaused(false);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const worker: BrowserWorker = Object.assign(new MockBrowserWorker(f.logger), { async performOutreach() { await pending; return { mode: "mock" as const }; } });
    const scheduler = f.scheduler(worker);
    const first = scheduler.run("outreach");
    assert.deepEqual(await scheduler.run("outreach"), { status: "skipped", reason: "Job already running" });
    release(); await first;
    assert.equal(f.leads.getById(lead.id)?.status, "SENT");
  } finally { f.db.close(); }
});

test("failed worker retries at most three times", async () => {
  const f = fixture();
  try {
    const lead = f.createLead(); f.approve(lead.id);
    const worker: BrowserWorker = Object.assign(new MockBrowserWorker(f.logger), { async performOutreach() { throw new Error("Mock failure"); } });
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.deepEqual(await runMockOutreach(f.leads, f.templates, worker, f.notifier, f.logger), { sent: 0, failed: 1 });
      assert.equal(f.leads.getById(lead.id)?.outreach_attempts, attempt);
      if (attempt < 3) f.leads.retry(lead.id);
    }
    assert.throws(() => f.leads.retry(lead.id), /fewer than 3/);
  } finally { f.db.close(); }
});

test("reply checks stop after three failures until manually retried", async () => {
  const f = fixture();
  try {
    const lead = f.createLead(); f.approve(lead.id);
    await runMockOutreach(f.leads, f.templates, new MockBrowserWorker(f.logger), f.notifier, f.logger);
    let calls = 0;
    const detector = { async hasReply() { calls++; throw new Error("Mock detector failed"); } };
    for (let i = 0; i < 4; i++) await runMockReplyMonitor(f.leads, detector, f.notifier, f.logger);
    assert.equal(calls, 3);
    assert.equal(f.leads.getById(lead.id)?.status, "SENT");
    assert.equal(f.leads.getById(lead.id)?.monitor_failures, 3);
    f.leads.retry(lead.id);
    assert.deepEqual(await runMockReplyMonitor(f.leads, new MockReplyDetector(), f.notifier, f.logger), { replied: 1, handoffs: 1 });
  } finally { f.db.close(); }
});

test("invalid URLs and duplicate leads are rejected", () => {
  const f = fixture();
  try {
    assert.throws(() => f.leads.create({ name: "A", linkedin_url: "https://example.com/in/a" }), /LinkedIn profile URL/);
    f.leads.create({ name: "A", linkedin_url: "https://www.linkedin.com/in/a" });
    assert.throws(() => f.leads.create({ name: "A", linkedin_url: "https://www.linkedin.com/in/a" }), /UNIQUE constraint/);
  } finally { f.db.close(); }
});
