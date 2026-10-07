import { openDatabase, migrateDatabase, requireInitialized } from "./db/index.js";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./config/logger.js";
import { LeadRepository } from "./leads/repository.js";
import { LeadService } from "./leads/service.js";
import { parseLeadStatus } from "./leads/types.js";
import { createBrowserWorker } from "./browser/playwright-worker.js";
import { MockReplyDetector } from "./monitor/workflow.js";
import { createNotifier } from "./telegram/notifier.js";
import { TemplateService } from "./templates/service.js";
import { SystemService } from "./system/service.js";
import { Scheduler } from "./scheduler/index.js";
import { PendingActionService } from "./outreach/pending.js";

const usage = `Usage:
  npm run db:init
  npm run lead:add -- --name "Jane Doe" --url "https://www.linkedin.com/in/jane-doe/" [--company "Acme"] [--template "intro-1"]
  npm run lead:list -- [--status APPROVED]
  npm run lead:status -- <id> <STATUS>
  npm run cli -- lead get <id>
  npm run cli -- template add --name "Intro" --body "Hi {{first_name}}"
  npm run cli -- template list
  npm run outreach:run
  npm run monitor:run`;

function flags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid option: ${flag ?? ""}\n${usage}`);
    }
    result[flag.slice(2)] = value;
  }
  return result;
}

async function main(): Promise<void> {
  const [area, action, ...args] = process.argv.slice(2);
  if (!area || area === "help" || area === "--help") {
    console.log(usage);
    return;
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = openDatabase(config.databasePath);
  try {
    if (area === "db" && action === "init") {
      migrateDatabase(db);
      logger.info("Database ready", { path: config.databasePath });
      return;
    }
    requireInitialized(db);
    const leads = new LeadService(new LeadRepository(db));
    const templates = new TemplateService(db);
    const system = new SystemService(db);

    if (area === "lead" && action === "add") {
      const options = flags(args);
      if (!options.name || !options.url) throw new Error(`--name and --url are required\n${usage}`);
      const lead = leads.create({ name: options.name, linkedin_url: options.url, company: options.company,
        job_title: options.job, location: options.location, template_id: options.template });
      logger.info("Lead created", { leadId: lead.id });
      console.log(JSON.stringify(lead, null, 2));
    } else if (area === "lead" && action === "list") {
      const options = flags(args);
      console.log(JSON.stringify(options.status ? leads.getByStatus(parseLeadStatus(options.status)) : leads.list(), null, 2));
    } else if (area === "lead" && action === "get") {
      const id = args[0];
      if (!id) throw new Error(`Lead id is required\n${usage}`);
      const lead = leads.getById(id);
      if (!lead) throw new Error(`Lead not found: ${id}`);
      console.log(JSON.stringify(lead, null, 2));
    } else if (area === "lead" && action === "status") {
      const [id, status] = args;
      if (!id || !status) throw new Error(`Lead id and status are required\n${usage}`);
      const lead = leads.updateStatus(id, parseLeadStatus(status));
      logger.info("Lead status updated", { leadId: id, status: lead.status });
      console.log(JSON.stringify(lead, null, 2));
    } else if (area === "template" && action === "add") {
      const options = flags(args);
      if (!options.name || !options.body) throw new Error(`--name and --body are required\n${usage}`);
      console.log(JSON.stringify(templates.create({ name: options.name, body: options.body }), null, 2));
    } else if (area === "template" && action === "list") {
      console.log(JSON.stringify(templates.list(), null, 2));
    } else if ((area === "outreach" || area === "monitor") && action === "run") {
      const notifier = createNotifier(config, logger);
      const worker = createBrowserWorker(config, logger);
      const scheduler = new Scheduler(config, system, leads, templates, worker, new MockReplyDetector(), notifier, logger,
        new PendingActionService(db, config.timezone));
      try {
        console.log(JSON.stringify(await scheduler.run(area === "outreach" ? "outreach" : "replies"), null, 2));
      } finally {
        await scheduler.shutdown();
      }
    } else {
      throw new Error(usage);
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
