import type { AppConfig } from "../config/index.js";
import type { Logger } from "../config/logger.js";
import type { BrowserWorker } from "../browser/worker.js";
import { BrowserActionError } from "../browser/types.js";
import type { LeadService } from "../leads/service.js";
import type { SystemService } from "../system/service.js";
import type { Notifier } from "../telegram/notifier.js";
import type { Lead } from "../leads/types.js";

export function replyButtons(lead: Lead, dashboardBaseUrl?: string) {
  const buttons: { text: string; url?: string; callback_data?: string }[][] = [];
  const links: { text: string; url: string }[] = [];
  const conversation = lead.conversation_url;
  if (conversation && /^https:\/\/(?:www\.)?linkedin\.com\/messaging\//.test(conversation)) {
    links.push({ text: "Open LinkedIn", url: conversation });
  } else {
    links.push({ text: "Open LinkedIn", url: lead.linkedin_url });
  }
  if (dashboardBaseUrl && /^https?:\/\//.test(dashboardBaseUrl)) {
    links.push({ text: "View Lead", url: `${dashboardBaseUrl}/leads/${encodeURIComponent(lead.id)}` });
  }
  buttons.push(links);
  buttons.push([{ text: "Sync Now", callback_data: `sync:${lead.id}` },
    { text: "Mark Handled", callback_data: `handled:${lead.id}` }]);
  return buttons;
}

export async function syncLeadConversation(
  leadId: string, leads: LeadService, worker: BrowserWorker, notifier: Notifier, logger: Logger,
  dashboardBaseUrl?: string,
): Promise<{ replied: boolean; newMessages: number; newIncoming: number; status: string }> {
  const lead = leads.getById(leadId);
  if (!lead || !["SENT", "REPLIED", "HUMAN_TAKEOVER"].includes(lead.status) || !lead.sent_at) {
    throw new Error("Conversation sync requires a sent or replied lead");
  }
  const known = new Set(leads.conversation(lead.id).map((message) => message.id));
  const result = await worker.checkReplyStatus(lead);
  const observed = [];
  for (const message of result.messages) {
    if (message.direction !== "unknown" && message.text && message.sentAt) {
      const stored = leads.recordConversationMessage(lead.id, message.direction, message.text, message.sentAt, "linkedin");
      if (stored) observed.push(stored);
    }
  }
  if (result.conversationUrl) leads.setConversationUrl(lead.id, result.conversationUrl);
  const newItems = observed.filter((message) => !known.has(message.id));
  const newIncoming = newItems.filter((message) => message.direction === "incoming").length;
  const lastIncoming = [...newItems].reverse().find((message) => message.direction === "incoming")?.body
    ?? result.reply?.text ?? "(teks balasan tidak tersedia)";
  leads.markChecked(lead.id);
  leads.activity.add("conversation_synced", `Conversation synced: ${newItems.length} new message(s)`, lead.id);
  leads.activity.add("reply_check", `Conversation checked: ${result.replied ? "reply found" : "no reply"}`, lead.id);

  if ((lead.status === "SENT" || lead.status === "REPLIED") && result.replied) {
    if (lead.status === "SENT") leads.updateStatus(lead.id, "REPLIED");
    leads.updateStatus(lead.id, "HUMAN_TAKEOVER");
    try {
      await notifier.notify(`💬 Balasan dari ${lead.name}\n${lead.company ?? "—"}\n\n${lastIncoming.slice(0, 2000)}\n\nLead ID: ${lead.id}\nLanjutkan percakapan secara manual.`,
        { buttons: replyButtons(leads.getById(lead.id)!, dashboardBaseUrl) });
    } catch { logger.warn("Reply notification failed; human takeover still recorded", { leadId: lead.id }); }
  } else if (lead.status === "HUMAN_TAKEOVER" && newIncoming > 0) {
    try {
      await notifier.notify(`💬 Pesan baru dari ${lead.name}\n\n${lastIncoming.slice(0, 2000)}\n\nLead ID: ${lead.id}`,
        { buttons: replyButtons(leads.getById(lead.id)!, dashboardBaseUrl) });
    } catch { logger.warn("New reply notification failed", { leadId: lead.id }); }
  }
  return { replied: result.replied, newMessages: newItems.length, newIncoming,
    status: leads.getById(lead.id)!.status };
}

export async function runProductionReplyMonitor(
  config: AppConfig, system: SystemService, leads: LeadService, worker: BrowserWorker,
  notifier: Notifier, logger: Logger,
): Promise<{ replied: number; checked: number; failed: number }> {
  let replied = 0;
  let checked = 0;
  let failed = 0;
  if (!config.automationEnabled || system.getSettings().paused) return { replied, checked, failed };
  for (const lead of leads.getByStatus("SENT")) {
    if (!config.automationEnabled || system.getSettings().paused) break;
    if (lead.monitor_failures >= 3 || lead.error_class === "auth_challenge") continue;
    try {
      const result = await syncLeadConversation(lead.id, leads, worker, notifier, logger, config.publicUrl);
      checked++;
      if (!result.replied) continue;
      replied++;
    } catch (error) {
      const kind = error instanceof BrowserActionError ? error.kind : "unknown_layout";
      const detail = error instanceof BrowserActionError ? error.message : "Unexpected reply worker error";
      leads.markChecked(lead.id, detail, kind, !["browser_offline", "temporary_navigation"].includes(kind));
      leads.activity.add(kind === "browser_offline" ? "browser_offline" : kind === "auth_challenge" ? "auth_challenge" : "worker_error",
        `Reply check ${kind}: ${detail}`, lead.id);
      failed++;
      logger.error("Reply monitor failed", { leadId: lead.id, kind });
      if (!["browser_offline", "temporary_navigation"].includes(kind)) {
        try { await notifier.notify(kind === "auth_challenge"
          ? `🔐 LinkedIn meminta login atau verifikasi. Periksa browser secara manual.\nLead: ${lead.name}\nLead ID: ${lead.id}`
          : `⚠️ Human review required\nLead ID: ${lead.id}\n${kind}: ${detail}`); }
        catch { logger.warn("Human review notification failed", { leadId: lead.id }); }
      }
    }
  }
  return { replied, checked, failed };
}
