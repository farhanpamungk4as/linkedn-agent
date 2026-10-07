import { openDatabase, migrateDatabase } from "../src/db/index.js";
import { LeadRepository } from "../src/leads/repository.js";
import { LeadService } from "../src/leads/service.js";
import { TemplateService } from "../src/templates/service.js";
import { SystemService } from "../src/system/service.js";
import { loadConfig } from "../src/config/index.js";
import { createLogger } from "../src/config/logger.js";
import { Scheduler } from "../src/scheduler/index.js";
import { MockBrowserWorker, type BrowserWorker } from "../src/browser/worker.js";
import { MockReplyDetector } from "../src/monitor/workflow.js";
import type { Notifier } from "../src/telegram/notifier.js";
import { PendingActionService } from "../src/outreach/pending.js";

export function fixture() {
  const db = openDatabase(":memory:");
  migrateDatabase(db); migrateDatabase(db);
  const leads = new LeadService(new LeadRepository(db));
  const templates = new TemplateService(db);
  const system = new SystemService(db);
  const config = loadConfig({});
  const pending = new PendingActionService(db, config.timezone);
  const logger = createLogger("error");
  const notices: string[] = [];
  const notifier: Notifier = { async notify(text) { notices.push(text); } };
  const template = templates.create({ name: "Intro", body: "Hi {{first_name}} at {{company}} ({{job_title}})" });
  const createLead = () => leads.create({ name: "Jane Doe", linkedin_url: "https://www.linkedin.com/in/jane-doe/",
    company: "Acme", job_title: "Director", template_id: template.id });
  const approve = (id: string) => { leads.updateStatus(id, "QUALIFIED"); leads.approve(id); };
  const scheduler = (worker: BrowserWorker = new MockBrowserWorker(logger)) =>
    new Scheduler(config, system, leads, templates, worker, new MockReplyDetector(), notifier, logger, pending);
  return { db, leads, templates, system, pending, config, logger, notices, notifier, template, createLead, approve, scheduler };
}
