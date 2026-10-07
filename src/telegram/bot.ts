import type { Logger } from "../config/logger.js";
import type { LeadService } from "../leads/service.js";
import type { SystemService } from "../system/service.js";
import type { Notifier } from "./notifier.js";
import type { PendingActionService } from "../outreach/pending.js";
import type { Scheduler } from "../scheduler/index.js";

export interface TelegramControlExtras {
  pending?: PendingActionService;
  scheduler?: Scheduler;
  dailyLimit?: number;
  approveAndSend?: (leadId: string) => Promise<{ status: string }>;
  syncConversation?: (leadId: string) => Promise<{ newMessages: number; newIncoming: number; status: string }>;
  dashboardBaseUrl?: string;
}

export interface TelegramMessage {
  text?: string;
  chat: { id: number };
  from?: { id: number };
}

export const TELEGRAM_COMMANDS = [
  { command: "start", description: "Tampilkan bantuan" },
  { command: "help", description: "Lihat daftar perintah" },
  { command: "status", description: "Status sistem dan browser" },
  { command: "replies", description: "Balasan yang perlu ditangani" },
  { command: "leads", description: "Lead yang perlu perhatian" },
  { command: "lead", description: "Detail lead berdasarkan ID" },
  { command: "sync", description: "Sinkronkan percakapan lead" },
  { command: "handled", description: "Tandai balasan sudah ditangani" },
  { command: "pending", description: "Lihat outreach tertunda" },
  { command: "approve", description: "Setujui outreach lead" },
  { command: "reject", description: "Tolak outreach lead" },
  { command: "pause", description: "Jeda pekerjaan browser" },
  { command: "resume", description: "Lanjutkan pekerjaan browser" },
  { command: "errors", description: "Lihat error lead" },
] as const;

export function parseCommand(text: string): { command: string; argument?: string } | null {
  const match = /^\/(start|status|pause|resume|leads|approve|reject|lead|pending|replies|errors|sync|handled|help)(?:@[\w_]+)?(?:\s+([^\s]+))?\s*$/i.exec(text.trim());
  return match ? { command: match[1]!.toLowerCase(), argument: match[2] } : null;
}

export async function handleTelegramCommand(
  message: TelegramMessage,
  allowedUserId: string,
  leads: LeadService,
  system: SystemService,
  notifier: Notifier,
  extras: TelegramControlExtras = {},
): Promise<string | null> {
  if (!allowedUserId || String(message.from?.id ?? "") !== allowedUserId) return null;
  const parsed = parseCommand(message.text ?? "");
  if (!parsed) return "Unknown command. Use /help to see available commands.";

  try {
    switch (parsed.command) {
      case "status": {
        const all = leads.list();
        const count = (status: string) => all.filter((lead) => lead.status === status).length;
        const scheduler = extras.scheduler?.status();
        return `System: ${system.getSettings().paused ? "PAUSED" : "RUNNING"}\nBrowser: ${scheduler?.worker_health ?? "UNKNOWN"}\nScheduler: ${scheduler?.health ?? "UNKNOWN"}\nNew: ${count("NEW")}\nApproved: ${count("APPROVED")}\nSent today: ${extras.pending?.sentToday() ?? count("SENT")}/${extras.dailyLimit ?? "—"}\nReplies: ${all.filter((lead) => lead.replied_at).length}\nFailed: ${count("FAILED")}`;
      }
      case "start":
      case "help":
        return ["LinkedIn Agent commands:", "/status — system status", "/replies — human takeover inbox",
          "/lead <id> — lead and last reply", "/sync <id> — sync LinkedIn conversation",
          "/handled <id> — mark human follow-up handled", "/pending — pending approvals",
          "/approve <id> — approve/send pending outreach", "/reject <id> — reject pending outreach",
          "/pause — pause browser jobs", "/resume — resume browser jobs"].join("\n");
      case "pause":
        system.setPaused(true);
        await safeNotify(notifier, "⏸ System paused");
        return "System paused.";
      case "resume":
        system.setPaused(false);
        await safeNotify(notifier, "▶️ System resumed");
        return "System resumed.";
      case "leads": {
        const attention = leads.list().filter((lead) => ["QUALIFIED", "FAILED", "REPLIED", "HUMAN_TAKEOVER"].includes(lead.status)).slice(0, 10);
        return attention.length ? attention.map((lead) => `${lead.name} · ${lead.status}\n${lead.id}`).join("\n\n") : "No leads need attention.";
      }
      case "pending": {
        const items = extras.pending?.list("PREPARED").slice(0, 10) ?? [];
        return items.length ? items.map((item) => `${item.mode}: ${leads.getById(item.lead_id)?.name ?? item.lead_id}\n${item.lead_id}`).join("\n\n") : "No pending actions.";
      }
      case "replies": {
        const items = leads.getByStatus("HUMAN_TAKEOVER")
          .sort((a, b) => String(b.replied_at).localeCompare(String(a.replied_at))).slice(0, 10);
        return items.length ? items.map((lead) => {
          const reply = leads.conversation(lead.id).filter((item) => item.direction === "incoming").at(-1);
          const preview = reply?.body.replace(/\s+/g, " ").slice(0, 180) || "Reply text is not synced yet.";
          const state = lead.human_handled_at ? "HANDLED" : "NEEDS REPLY";
          const link = extras.dashboardBaseUrl ? `\n${extras.dashboardBaseUrl}/leads/${encodeURIComponent(lead.id)}` : "";
          return `${lead.name} · ${state}\n${preview}\n${lead.id}${link}`;
        }).join("\n\n") : "No human takeover replies.";
      }
      case "errors": {
        const items = leads.list().filter((lead) => lead.error_message).slice(0, 10);
        return items.length ? items.map((lead) => `${lead.name} · ${lead.error_class ?? "error"}\n${lead.id}`).join("\n\n") : "No errors.";
      }
      case "approve": {
        if (!parsed.argument) return "Usage: /approve <lead_id>";
        const pending = extras.pending?.get(parsed.argument);
        if (pending) {
          if (pending.mode === "manual") return "Manual mode: send on LinkedIn, then confirm in dashboard.";
          if (pending.state !== "PREPARED" || !extras.approveAndSend) return "Pending action is not ready for approval.";
          const result = await extras.approveAndSend(parsed.argument);
          return `Send result: ${result.status}. Check dashboard for details.`;
        }
        const lead = leads.approve(parsed.argument);
        await safeNotify(notifier, `✅ Lead approved\n${lead.name}\n${lead.id}`);
        return `Approved: ${lead.name}`;
      }
      case "reject": {
        if (!parsed.argument) return "Usage: /reject <lead_id>";
        const lead = extras.pending?.get(parsed.argument) ? extras.pending.reject(parsed.argument) : leads.reject(parsed.argument);
        return `Skipped: ${lead.name}`;
      }
      case "lead": {
        if (!parsed.argument) return "Usage: /lead <lead_id>";
        const lead = leads.getById(parsed.argument);
        if (!lead) return "Lead not found.";
        const reply = leads.conversation(lead.id).filter((item) => item.direction === "incoming").at(-1);
        const link = extras.dashboardBaseUrl ? `\n${extras.dashboardBaseUrl}/leads/${encodeURIComponent(lead.id)}` : "";
        return `${lead.name}\n${lead.company ?? "—"}\n${lead.status}\nHandled: ${lead.human_handled_at ? "yes" : "no"}\nLast reply: ${reply?.body || "—"}\n${lead.id}${link}`;
      }
      case "sync": {
        if (!parsed.argument) return "Usage: /sync <lead_id>";
        if (!extras.syncConversation) return "Conversation sync is unavailable.";
        const result = await extras.syncConversation(parsed.argument);
        return `Sync complete. New messages: ${result.newMessages}; incoming: ${result.newIncoming}; status: ${result.status}.`;
      }
      case "handled": {
        if (!parsed.argument) return "Usage: /handled <lead_id>";
        const lead = leads.markHumanHandled(parsed.argument);
        return `Handled: ${lead.name}`;
      }
      default: return "Unknown command.";
    }
  } catch (error) {
    return error instanceof Error && /^(Invalid transition|Lead not found|Cannot retry|Assign a template|Only HUMAN_TAKEOVER|Automation is disabled|Conversation sync)/.test(error.message)
      ? error.message : "Command failed. Check dashboard activity.";
  }
}

async function safeNotify(notifier: Notifier, text: string): Promise<void> {
  try { await notifier.notify(text); } catch { /* Control action already committed. */ }
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: { id: number } };
  };
}

export class TelegramBot {
  private controller = new AbortController();
  private running = false;
  private readonly processing = new Map<number, Promise<void>>();

  constructor(
    private readonly token: string,
    private readonly allowedUserId: string,
    private readonly leads: LeadService,
    private readonly system: SystemService,
    private readonly notifier: Notifier,
    private readonly logger: Logger,
    private readonly extras: TelegramControlExtras = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.registerCommands();
    void this.poll();
  }

  async registerCommands(): Promise<void> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.token}/setMyCommands`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: TELEGRAM_COMMANDS,
          scope: { type: "chat", chat_id: Number(this.allowedUserId) } }),
      });
      const data = await response.json() as { ok?: boolean; description?: string };
      if (!response.ok || !data.ok) throw new Error(data.description ?? `HTTP ${response.status}`);
      this.logger.info("Telegram command menu registered");
    } catch (error) {
      this.logger.warn("Telegram command menu registration failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  stop(): void { this.running = false; this.controller.abort(); }

  private async poll(): Promise<void> {
    this.logger.info("Telegram control polling started");
    while (this.running) {
      try {
        this.controller = new AbortController();
        const params = new URLSearchParams({ offset: String(this.system.getTelegramOffset()), timeout: "20", allowed_updates: JSON.stringify(["message", "callback_query"]) });
        const response = await fetch(`https://api.telegram.org/bot${this.token}/getUpdates?${params}`, { signal: this.controller.signal });
        if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
        const data = await response.json() as { ok: boolean; result: TelegramUpdate[] };
        if (!data.ok) throw new Error("Telegram polling rejected");
        for (const update of data.result) await this.handleUpdate(update);
      } catch (error) {
        if (!this.running) break;
        this.logger.error("Telegram polling error", { error: error instanceof Error ? error.message : String(error) });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error("Invalid Telegram update ID");
    if (update.update_id < this.system.getTelegramOffset()) return;
    const inFlight = this.processing.get(update.update_id);
    if (inFlight) return inFlight;
    const task = this.processUpdate(update);
    this.processing.set(update.update_id, task);
    try { await task; } finally { this.processing.delete(update.update_id); }
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      const answer = await handleTelegramCommand(update.message, this.allowedUserId, this.leads, this.system, this.notifier, this.extras);
      if (answer) await this.send(update.message.chat.id, answer);
    } else if (update.callback_query) {
      const callback = update.callback_query;
      if (!callback.id || !callback.from || !callback.message) throw new Error("Invalid Telegram callback");
      if (String(callback.from.id) !== this.allowedUserId) {
        await this.answerCallback(callback.id, "Akses tidak diizinkan");
      } else {
        const match = /^(sync|handled):([0-9a-f-]{36})$/i.exec(callback.data ?? "");
        await this.answerCallback(callback.id, match ? "Sedang diproses..." : "Tombol tidak dikenal");
        if (match) {
          const answer = await handleTelegramCommand({ text: `/${match[1]} ${match[2]}`, chat: callback.message.chat, from: callback.from },
            this.allowedUserId, this.leads, this.system, this.notifier, this.extras);
          if (answer) await this.send(callback.message.chat.id, answer);
        }
      }
    }
    this.system.setTelegramOffset(update.update_id + 1);
  }

  private async answerCallback(id: string, text: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, text }),
    });
    if (!response.ok) throw new Error(`Telegram callback HTTP ${response.status}`);
  }

  private async send(chatId: number, text: string): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) throw new Error(`Telegram reply HTTP ${response.status}`);
  }
}
