import { openDatabase, requireInitialized } from "./db/index.js";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./config/logger.js";
import { LeadRepository } from "./leads/repository.js";
import { LeadService } from "./leads/service.js";
import { TemplateService } from "./templates/service.js";
import { SystemService } from "./system/service.js";
import { createBrowserWorker } from "./browser/playwright-worker.js";
import { MockReplyDetector } from "./monitor/workflow.js";
import { createNotifier } from "./telegram/notifier.js";
import { TelegramBot } from "./telegram/bot.js";
import { Scheduler } from "./scheduler/index.js";
import { createApiServer } from "./api/server.js";
import { AuthService } from "./auth/service.js";
import { PendingActionService } from "./outreach/pending.js";
import { createHermesClient } from "./hermes/client.js";
import { approveAndSend } from "./outreach/production.js";
import { syncLeadConversation } from "./monitor/production.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const db = openDatabase(config.databasePath);
requireInitialized(db);
const leads = new LeadService(new LeadRepository(db));
const templates = new TemplateService(db);
const system = new SystemService(db);
const notifier = createNotifier(config, logger);
const auth = new AuthService(config);
const pending = new PendingActionService(db, config.timezone);
const worker = createBrowserWorker(config, logger);
const hermes = createHermesClient(config);
const scheduler = new Scheduler(config, system, leads, templates, worker, new MockReplyDetector(), notifier, logger, pending);
const bot = config.telegramBotToken && config.telegramAllowedUserId
  ? new TelegramBot(config.telegramBotToken, config.telegramAllowedUserId, leads, system, notifier, logger,
    { pending, scheduler, dailyLimit: config.outreachDailyLimit,
      dashboardBaseUrl: config.publicUrl,
      approveAndSend: (leadId) => approveAndSend(leadId, config, system, leads, pending, worker, notifier, logger),
      syncConversation: async (leadId) => {
        const settings = system.getSettings();
        if (!config.automationEnabled || settings.paused || !settings.monitor_enabled || !config.monitorEnabled) {
          throw new Error("Automation is disabled or paused");
        }
        if (scheduler.status().running_jobs.includes("replies")) throw new Error("Conversation sync is already running");
        return syncLeadConversation(leadId, leads, worker, notifier, logger, config.publicUrl);
      } }) : null;
const api = createApiServer({ config, leads, templates, system, scheduler, notifier, logger, auth, pending, worker, hermes, telegramBot: bot });

api.listen(config.appPort, config.appHost, () => {
  scheduler.start();
  if (config.telegramMode === "polling") bot?.start();
  else if (bot) {
    void bot.registerCommands();
    logger.info("Telegram webhook receiver ready", { path: "/api/telegram/webhook" });
  }
  logger.info("Dashboard ready", { url: `http://${config.appHost}:${config.appPort}` });
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  bot?.stop();
  await Promise.allSettled([
    new Promise<void>((resolve) => api.close(() => resolve())),
    scheduler.shutdown(),
  ]);
  db.close();
}
process.once("SIGINT", () => { void shutdown().catch((error: unknown) => logger.error("Shutdown failed", { error: String(error) })); });
process.once("SIGTERM", () => { void shutdown().catch((error: unknown) => logger.error("Shutdown failed", { error: String(error) })); });
