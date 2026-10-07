import type { BrowserWorker } from "../browser/worker.js";
import type { Logger } from "../config/logger.js";
import type { LeadService } from "../leads/service.js";
import type { Notifier } from "../telegram/notifier.js";
import type { TemplateService } from "../templates/service.js";
import { renderTemplate, valuesForLead } from "../templates/service.js";

async function notifySafely(notifier: Notifier, logger: Logger, message: string): Promise<void> {
  try { await notifier.notify(message); }
  catch (error) { logger.error("Notification failed", { error: error instanceof Error ? error.message : String(error) }); }
}

export async function runMockOutreach(
  leads: LeadService,
  templates: TemplateService,
  worker: BrowserWorker,
  notifier: Notifier,
  logger: Logger,
): Promise<{ sent: number; failed: number }> {
  const approved = leads.getByStatus("APPROVED");
  logger.info("Starting mock outreach", { count: approved.length });
  let sent = 0;
  let failed = 0;
  for (const lead of approved) {
    if (!leads.claimOutreach(lead.id)) continue;
    leads.activity.add("outreach_started", `Mock outreach started: ${lead.name}`, lead.id);
    try {
      if (!lead.template_id) throw new Error("No template assigned");
      const template = templates.get(lead.template_id);
      if (!template) throw new Error("Assigned template no longer exists");
      const message = renderTemplate(template.body, valuesForLead(lead));
      const result = await worker.performOutreach(lead, message);
      if (result.mode !== "mock") throw new Error("Only mock browser work is allowed in this phase");
      leads.updateStatus(lead.id, "SENT");
      sent += 1;
      logger.info("Lead moved to SENT", { leadId: lead.id });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      leads.markError(lead.id, detail);
      leads.updateStatus(lead.id, "FAILED");
      failed += 1;
      logger.error("Mock worker error", { leadId: lead.id, error: detail });
      await notifySafely(notifier, logger, `❌ Worker error\nLead ID: ${lead.id}\n${detail}`);
    }
  }
  if (sent) await notifySafely(notifier, logger, `📤 Outreach selesai untuk ${sent} lead`);
  return { sent, failed };
}
