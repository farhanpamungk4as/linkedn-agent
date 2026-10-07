import type { Logger } from "../config/logger.js";
import type { LeadService } from "../leads/service.js";
import type { Notifier } from "../telegram/notifier.js";

export interface ReplyDetector {
  hasReply(leadId: string): Promise<boolean>;
}

export class MockReplyDetector implements ReplyDetector {
  async hasReply(_leadId: string): Promise<boolean> { return true; }
}

export async function runMockReplyMonitor(
  leads: LeadService,
  detector: ReplyDetector,
  notifier: Notifier,
  logger: Logger,
): Promise<{ replied: number; handoffs: number }> {
  const awaitingReply = leads.getByStatus("SENT");
  let replied = 0;
  let handoffs = 0;
  logger.info("Starting mock reply monitor", { sent: awaitingReply.length });

  for (const lead of awaitingReply) {
    if (lead.monitor_failures >= 3) continue;
    try {
      const hasReply = await detector.hasReply(lead.id);
      leads.markChecked(lead.id);
      if (!hasReply) continue;
      leads.updateStatus(lead.id, "REPLIED");
      replied += 1;
      logger.info("Mock reply detected", { leadId: lead.id });
      try {
        await notifier.notify(`⚠️ Prospect replied\nName: ${lead.name}\nCompany: ${lead.company ?? "—"}\nLead ID: ${lead.id}\nAutomation stopped for this lead.\nContinue manually.`);
      } catch (error) {
        logger.error("Reply notification failed", { leadId: lead.id, error: error instanceof Error ? error.message : String(error) });
      }
      leads.updateStatus(lead.id, "HUMAN_TAKEOVER");
      handoffs += 1;
      logger.info("Lead moved to HUMAN_TAKEOVER", { leadId: lead.id });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      leads.markChecked(lead.id, detail);
      logger.error("Mock reply check failed", { leadId: lead.id, error: detail });
      leads.activity.add("reply_check_failed", `Reply check failed: ${detail}`, lead.id);
    }
  }
  return { replied, handoffs };
}
