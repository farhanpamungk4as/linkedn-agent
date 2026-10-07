import type { DatabaseSync } from "node:sqlite";
import { ActivityService } from "../activity/service.js";
import { LeadRepository } from "../leads/repository.js";
import { assertTransition } from "../leads/transitions.js";
import type { Lead } from "../leads/types.js";
import type { PreparedOutreach } from "../browser/types.js";
import { localDay } from "../system/day.js";

export type PendingState = "PREPARED" | "SENDING" | "SENT" | "CANCELLED" | "UNCERTAIN" | "BLOCKED";
export interface PendingAction {
  lead_id: string;
  mode: "manual" | "approval";
  state: PendingState;
  message: string;
  profile_name: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  send_started_at: string | null;
  sent_at: string | null;
  send_day: string | null;
  send_attempts: number;
  last_error: string | null;
  kind: "initial" | "follow_up";
}

export class PendingActionService {
  private readonly repository: LeadRepository;
  private readonly activity: ActivityService;
  constructor(private readonly db: DatabaseSync, private readonly timezone: string) {
    this.repository = new LeadRepository(db);
    this.activity = new ActivityService(db);
  }

  get(leadId: string): PendingAction | undefined {
    return this.db.prepare("SELECT * FROM pending_actions WHERE lead_id = ?").get(leadId) as unknown as PendingAction | undefined;
  }

  list(state?: PendingState): PendingAction[] {
    const query = state
      ? this.db.prepare("SELECT * FROM pending_actions WHERE state = ? ORDER BY created_at DESC")
      : this.db.prepare("SELECT * FROM pending_actions ORDER BY created_at DESC");
    return (state ? query.all(state) : query.all()) as unknown as PendingAction[];
  }

  prepare(leadId: string, mode: "manual" | "approval", result: PreparedOutreach): PendingAction {
    return this.repository.transaction(() => {
      const lead = this.requireLead(leadId);
      if (lead.status !== "APPROVED" || lead.sent_at || !lead.outreach_claimed_at) throw new Error("Lead is not available for preparation");
      const existing = this.get(leadId);
      if (existing?.state === "CANCELLED") this.db.prepare("DELETE FROM pending_actions WHERE lead_id = ? AND state = 'CANCELLED'").run(leadId);
      else if (existing) throw new Error("Pending action already exists for lead");
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO pending_actions
        (lead_id, mode, state, message, profile_name, created_at, updated_at, kind)
        VALUES (?, ?, 'PREPARED', ?, ?, ?, ?, 'initial')`).run(leadId, mode, result.message, result.profileName, now, now);
      this.activity.add("outreach_prepared", `${mode} outreach prepared for ${lead.name}`, leadId);
      return this.get(leadId)!;
    });
  }

  prepareFollowUp(leadId: string, result: PreparedOutreach): PendingAction {
    return this.repository.transaction(() => {
      const lead = this.requireLead(leadId);
      const existing = this.get(leadId);
      if (lead.status !== "SENT" || !lead.sent_at || !existing || existing.state !== "SENT") {
        throw new Error("Follow-up requires a sent lead without another pending action");
      }
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE leads SET status = 'APPROVED', last_checked_at = NULL, error_message = NULL,
        error_class = NULL, monitor_failures = 0, outreach_claimed_at = NULL, updated_at = ? WHERE id = ? AND status = 'SENT'`)
        .run(now, leadId);
      this.db.prepare(`UPDATE pending_actions SET mode = 'approval', state = 'PREPARED', message = ?, profile_name = ?,
        kind = 'follow_up', created_at = ?, updated_at = ?, approved_at = NULL, send_started_at = NULL,
        send_attempts = 0, last_error = NULL WHERE lead_id = ? AND state = 'SENT'`)
        .run(result.message, result.profileName, now, now, leadId);
      this.activity.add("follow_up_prepared", `Follow-up prepared for ${lead.name}`, leadId);
      return this.get(leadId)!;
    });
  }

  reserveSend(leadId: string, dailyLimit: number): PendingAction {
    return this.repository.transaction(() => {
      const pending = this.get(leadId);
      const lead = this.requireLead(leadId);
      const validLead = lead.status === "APPROVED" && (pending?.kind === "follow_up" ? Boolean(lead.sent_at) : !lead.sent_at);
      if (!pending || pending.mode !== "approval" || pending.state !== "PREPARED" || !validLead) {
        throw new Error("No approved pending action is available to send");
      }
      if (Date.parse(lead.updated_at) > Date.parse(pending.created_at)) throw new Error("Lead changed since message preparation; review manually");
      if (pending.send_attempts >= 3) throw new Error("Send attempt limit reached; reconcile manually");
      const day = localDay(new Date(), this.timezone);
      if (this.sentToday() + this.inFlightToday(day) >= dailyLimit) throw new Error("Daily outreach limit reached");
      const now = new Date().toISOString();
      const result = this.db.prepare(`UPDATE pending_actions SET state = 'SENDING', approved_at = ?, send_started_at = ?,
        send_day = ?, send_attempts = send_attempts + 1, updated_at = ?, last_error = NULL
        WHERE lead_id = ? AND state = 'PREPARED'`).run(now, now, day, now, leadId);
      if (result.changes !== 1) throw new Error("Pending action changed concurrently");
      this.activity.add("approval_received", `Explicit send approval received for ${lead.name}`, leadId);
      return this.get(leadId)!;
    });
  }

  markSent(leadId: string, manual: boolean): Lead {
    return this.repository.transaction(() => {
      const pending = this.get(leadId);
      const lead = this.requireLead(leadId);
      const validLead = lead.status === "APPROVED" && (pending?.kind === "follow_up" ? Boolean(lead.sent_at) : !lead.sent_at);
      if (!pending || !validLead) throw new Error("Lead has already been sent or changed");
      if (manual ? !["PREPARED", "BLOCKED", "UNCERTAIN"].includes(pending.state) : pending.state !== "SENDING") {
        throw new Error("Pending action cannot be confirmed in its current state");
      }
      const now = new Date().toISOString();
      let updated: Lead;
      if (pending.kind === "follow_up") {
        this.db.prepare(`UPDATE leads SET status = 'SENT', sent_at = ?, last_checked_at = NULL,
          error_message = NULL, error_class = NULL, monitor_failures = 0, updated_at = ?
          WHERE id = ? AND status = 'APPROVED'`).run(now, now, leadId);
        updated = this.requireLead(leadId);
      } else {
        assertTransition(lead, "SENT");
        updated = this.repository.updateStatus(leadId, "SENT")!;
      }
      this.db.prepare(`UPDATE pending_actions SET state = 'SENT', sent_at = ?, send_day = ?, updated_at = ?, last_error = NULL
        WHERE lead_id = ?`).run(updated.sent_at, localDay(new Date(updated.sent_at!), this.timezone), now, leadId);
      this.repository.recordConversationMessage(leadId, "outgoing", pending.message, updated.sent_at!, manual ? "manual" : "playwright");
      this.activity.add(manual ? "manually_confirmed_sent" : "message_sent", `${manual ? "Human confirmed send" : "Playwright send confirmed"}: ${lead.name}`, leadId);
      return updated;
    });
  }

  correctManualNotSent(leadId: string): Lead {
    return this.repository.transaction(() => {
      const pending = this.get(leadId);
      const lead = this.requireLead(leadId);
      if (!pending || pending.mode !== "manual" || pending.state !== "SENT" || pending.send_attempts !== 0 || lead.status !== "SENT") {
        throw new Error("Only a manually confirmed, unsent browser action can be corrected");
      }
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE pending_actions SET state = 'CANCELLED', updated_at = ?, last_error = ? WHERE lead_id = ?`)
        .run(now, "Manual send confirmation corrected: message was not sent", leadId);
      this.db.prepare(`UPDATE leads SET status = 'APPROVED', sent_at = NULL, last_checked_at = NULL,
        error_message = NULL, error_class = NULL, monitor_failures = 0, outreach_claimed_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENT'`).run(now, leadId);
      this.activity.add("manual_send_corrected", `Manual send confirmation corrected: ${lead.name}`, leadId);
      return this.requireLead(leadId);
    });
  }

  markSendError(leadId: string, kind: string, message: string, uncertain: boolean): PendingAction {
    return this.repository.transaction(() => {
      const pending = this.get(leadId);
      if (!pending || pending.state !== "SENDING") throw new Error("Pending send is not active");
      const retryable = ["browser_offline", "temporary_navigation"].includes(kind) && pending.send_attempts < 3;
      const state: PendingState = uncertain ? "UNCERTAIN" : retryable ? "PREPARED" : "BLOCKED";
      this.db.prepare("UPDATE pending_actions SET state = ?, last_error = ?, updated_at = ? WHERE lead_id = ?")
        .run(state, message.slice(0, 500), new Date().toISOString(), leadId);
      this.repository.markError(leadId, message, kind);
      this.activity.add(kind === "browser_offline" ? "browser_offline" : kind === "auth_challenge" ? "auth_challenge" : "worker_error",
        `Send ${state.toLowerCase()}: ${message}`, leadId);
      return this.get(leadId)!;
    });
  }

  reject(leadId: string): Lead {
    return this.repository.transaction(() => {
      const pending = this.get(leadId);
      const lead = this.requireLead(leadId);
      if (!pending || !["PREPARED", "BLOCKED"].includes(pending.state)) throw new Error("Pending action cannot be rejected safely");
      assertTransition(lead, "SKIPPED");
      this.db.prepare("UPDATE pending_actions SET state = 'CANCELLED', updated_at = ? WHERE lead_id = ?")
        .run(new Date().toISOString(), leadId);
      const updated = this.repository.updateStatus(leadId, "SKIPPED")!;
      this.activity.add("rejected", `Pending outreach rejected: ${lead.name}`, leadId);
      return updated;
    });
  }

  sentToday(): number {
    return this.repository.list().filter((lead) => lead.sent_at && localDay(new Date(lead.sent_at), this.timezone) === localDay(new Date(), this.timezone)).length;
  }

  private inFlightToday(day: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM pending_actions WHERE state = 'SENDING' AND send_day = ?")
      .get(day) as { count: number }).count;
  }

  private requireLead(id: string): Lead {
    const lead = this.repository.getById(id);
    if (!lead) throw new Error(`Lead not found: ${id}`);
    return lead;
  }
}
