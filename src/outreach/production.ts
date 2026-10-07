import type { AppConfig } from "../config/index.js";
import type { Logger } from "../config/logger.js";
import type { BrowserWorker } from "../browser/worker.js";
import { BrowserActionError } from "../browser/types.js";
import type { LeadService } from "../leads/service.js";
import type { SystemService } from "../system/service.js";
import type { Notifier } from "../telegram/notifier.js";
import { renderTemplate, valuesForLead, type TemplateService } from "../templates/service.js";
import type { PendingActionService } from "./pending.js";

async function notify(notifier: Notifier, logger: Logger, text: string): Promise<void> {
  try { await notifier.notify(text); }
  catch { logger.warn("Notification failed; core workflow continued"); }
}

export async function runProductionOutreach(
  config: AppConfig, system: SystemService, leads: LeadService, templates: TemplateService,
  pending: PendingActionService, worker: BrowserWorker, notifier: Notifier, logger: Logger,
): Promise<{ prepared: number; failed: number; limitReached: boolean }> {
  if (!config.automationEnabled || system.getSettings().paused) return { prepared: 0, failed: 0, limitReached: false };
  let prepared = 0;
  let failed = 0;
  let limitReached = false;
  for (const lead of leads.getByStatus("APPROVED")) {
    if (!config.automationEnabled || system.getSettings().paused) break;
    if (pending.sentToday() >= config.outreachDailyLimit) {
      limitReached = true;
      leads.activity.add("daily_limit_reached", `Daily limit ${config.outreachDailyLimit} reached`);
      break;
    }
    const existingPending = pending.get(lead.id);
    if ((existingPending && existingPending.state !== "CANCELLED") || !leads.claimOutreach(lead.id)) continue;
    leads.activity.add("outreach_started", `Profile verification started: ${lead.name}`, lead.id);
    try {
      const template = lead.template_id && templates.get(lead.template_id);
      if (!template) throw new BrowserActionError("unknown_layout", "Assigned template is unavailable");
      const message = renderTemplate(template.body, valuesForLead(lead));
      const result = await worker.prepareOutreach(lead, message);
      pending.prepare(lead.id, config.outreachMode, result);
      prepared++;
      await notify(notifier, logger, `⏳ Pending ${config.outreachMode === "manual" ? "manual send" : "approval"}\n${lead.name}\nLead ID: ${lead.id}`);
    } catch (error) {
      const kind = error instanceof BrowserActionError ? error.kind : "unknown_layout";
      const detail = error instanceof BrowserActionError ? error.message : "Unexpected browser worker error";
      leads.markError(lead.id, detail, kind);
      const current = leads.getById(lead.id)!;
      if (["browser_offline", "temporary_navigation"].includes(kind) && current.outreach_attempts < 3) {
        leads.releaseOutreachClaim(lead.id);
      } else {
        leads.updateStatus(lead.id, "FAILED");
      }
      leads.activity.add(kind === "browser_offline" ? "browser_offline" : kind === "auth_challenge" ? "auth_challenge" : "worker_error",
        `${kind}: ${detail}`, lead.id);
      logger.error("Outreach preparation failed", { leadId: lead.id, kind });
      failed++;
      await notify(notifier, logger, kind === "auth_challenge"
        ? `🔐 LinkedIn meminta login atau verifikasi. Periksa browser secara manual.\nLead: ${lead.name}\nLead ID: ${lead.id}`
        : `❌ Worker error\nLead ID: ${lead.id}\n${kind}: ${detail}`);
    }
  }
  return { prepared, failed, limitReached };
}

export async function prepareFollowUp(
  leadId: string, config: AppConfig, system: SystemService, leads: LeadService,
  templates: TemplateService, pending: PendingActionService, worker: BrowserWorker,
  notifier: Notifier, logger: Logger,
) {
  const settings = system.getSettings();
  if (config.outreachMode !== "approval") throw new Error("Follow-up requires approval outreach mode");
  if (!config.automationEnabled || settings.paused || !settings.outreach_enabled || !config.outreachEnabled) {
    throw new Error("Automation is disabled or paused");
  }
  const lead = leads.getById(leadId);
  if (!lead || lead.status !== "SENT" || !lead.sent_at) throw new Error("Follow-up requires a sent lead");
  const template = lead.template_id && templates.get(lead.template_id);
  if (!template) throw new Error("Assigned template is unavailable");
  const message = renderTemplate(template.body, valuesForLead(lead));
  const result = await worker.prepareFollowUp(lead, message);
  const action = pending.prepareFollowUp(leadId, result);
  await notify(notifier, logger, `⏳ Follow-up pending approval\n${lead.name}\nLead ID: ${lead.id}`);
  return action;
}

export async function approveAndSend(
  leadId: string, config: AppConfig, system: SystemService, leads: LeadService,
  pending: PendingActionService, worker: BrowserWorker, notifier: Notifier, logger: Logger,
): Promise<{ status: "sent" | "uncertain" | "blocked"; reason?: string }> {
  const settings = system.getSettings();
  if (!config.automationEnabled || settings.paused || !settings.outreach_enabled || !config.outreachEnabled) {
    throw new Error("Automation is disabled or paused");
  }
  const action = pending.reserveSend(leadId, config.outreachDailyLimit);
  const lead = leads.getById(leadId)!;
  try {
    const result = await worker.sendApprovedOutreach(lead, action.message, action.kind === "follow_up");
    if (result.status === "uncertain") {
      pending.markSendError(leadId, "send_uncertain", "Send was clicked but confirmation was not observed", true);
      await notify(notifier, logger, `⚠️ Send uncertain. Inspect LinkedIn manually.\nLead ID: ${leadId}`);
      return { status: "uncertain" };
    }
    pending.markSent(leadId, false);
    await notify(notifier, logger, `📤 Outreach selesai untuk 1 lead\n${lead.name}\n${leadId}`);
    return { status: "sent" };
  } catch (error) {
    const kind = error instanceof BrowserActionError ? error.kind : "send_uncertain";
    const detail = error instanceof BrowserActionError ? error.message : "Unexpected send error; inspect conversation manually";
    const uncertain = kind === "send_uncertain" || !(error instanceof BrowserActionError);
    const updated = pending.markSendError(leadId, kind, detail, uncertain);
    await notify(notifier, logger, kind === "auth_challenge"
      ? `🔐 LinkedIn meminta login atau verifikasi. Periksa browser secara manual.\nLead: ${lead.name}\nLead ID: ${leadId}`
      : `❌ Worker error\nLead ID: ${leadId}\n${kind}: ${detail}`);
    logger.error("Approved send failed", { leadId, kind });
    return { status: updated.state === "UNCERTAIN" ? "uncertain" : "blocked", reason: detail };
  }
}
