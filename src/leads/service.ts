import type { LeadRepository } from "./repository.js";
import { ActivityService } from "../activity/service.js";
import { assertTransition } from "./transitions.js";
import type { ConversationDirection, ConversationMessage, Lead, LeadPatch, LeadStatus, NewLead } from "./types.js";

export class LeadService {
  readonly activity: ActivityService;
  constructor(private readonly repository: LeadRepository) {
    this.activity = new ActivityService(repository.db);
  }

  create(input: NewLead): Lead {
    const name = input.name.trim();
    const linkedinUrl = input.linkedin_url.trim();
    if (!name || name.length > 200) throw new Error("Lead name must be 1–200 characters");
    let url: URL;
    try {
      url = new URL(linkedinUrl);
    } catch {
      throw new Error("linkedin_url must be a valid HTTPS LinkedIn profile URL");
    }
    if (url.protocol !== "https:" || !["linkedin.com", "www.linkedin.com"].includes(url.hostname) ||
      !/^\/in\/[^/]+\/?$/.test(url.pathname) || url.username || url.password || url.port) {
      throw new Error("linkedin_url must be a valid HTTPS LinkedIn profile URL");
    }
    if (input.score != null && (!Number.isInteger(input.score) || input.score < 0 || input.score > 100)) {
      throw new Error("Score must be an integer from 0 to 100");
    }
    if (input.template_id) this.assertTemplate(input.template_id);
    return this.repository.transaction(() => {
      const lead = this.repository.create({
        name, linkedin_url: url.toString(), company: clean(input.company), job_title: clean(input.job_title),
        location: clean(input.location), score: input.score, score_reason: clean(input.score_reason ?? undefined),
        template_id: input.template_id,
      });
      this.activity.add("lead_created", `Lead created: ${lead.name}`, lead.id);
      return lead;
    });
  }

  list(): Lead[] { return this.repository.list(); }
  getById(id: string): Lead | undefined { return this.repository.getById(id); }
  getByStatus(status: LeadStatus): Lead[] { return this.repository.getByStatus(status); }
  conversation(id: string): ConversationMessage[] {
    this.require(id);
    return this.repository.listConversationMessages(id);
  }
  recordConversationMessage(id: string, direction: ConversationDirection, body: string, sentAt: string,
    source: ConversationMessage["source"]): ConversationMessage | undefined {
    this.require(id);
    return this.repository.recordConversationMessage(id, direction, body, sentAt, source);
  }
  markHumanHandled(id: string): Lead {
    const current = this.require(id);
    if (current.status !== "HUMAN_TAKEOVER") throw new Error("Only HUMAN_TAKEOVER leads can be marked handled");
    const updated = this.repository.markHumanHandled(id)!;
    this.activity.add("human_handled", `Human follow-up marked handled: ${updated.name}`, id);
    return updated;
  }
  setConversationUrl(id: string, value: string | null): void { this.repository.setConversationUrl(id, value); }
  updateStatus(id: string, status: LeadStatus): Lead {
    return this.repository.transaction(() => {
      const current = this.require(id);
      assertTransition(current, status);
      if (status === "APPROVED" && !current.template_id) throw new Error("Assign a template before approval");
      const lead = this.repository.updateStatus(id, status)!;
      const events: Record<LeadStatus, string> = {
        NEW: "lead_created", QUALIFIED: "lead_qualified", APPROVED: "approved", SENT: "message_sent",
        REPLIED: "reply_detected", HUMAN_TAKEOVER: "human_takeover", SKIPPED: "rejected", FAILED: "failed",
      };
      this.activity.add(events[status], `${current.status} → ${status}: ${lead.name}`, id);
      return lead;
    });
  }

  patch(id: string, input: LeadPatch): Lead {
    this.require(id);
    const fields: LeadPatch = {};
    for (const key of ["name", "company", "job_title", "location", "score_reason", "template_id"] as const) {
      if (key in input) {
        const value = input[key];
        if (value !== null && typeof value !== "string") throw new Error(`${key} must be a string or null`);
        if (key === "name" && (!value?.trim() || value.length > 200)) throw new Error("Name must be 1–200 characters");
        if (value && value.length > 200 && key !== "score_reason") throw new Error(`${key} is too long`);
        if (key === "template_id" && value) this.assertTemplate(value);
        fields[key] = value?.trim() || null;
      }
    }
    if ("score" in input) {
      if (input.score != null && (!Number.isInteger(input.score) || input.score < 0 || input.score > 100)) throw new Error("Score must be an integer from 0 to 100");
      fields.score = input.score ?? null;
    }
    return this.repository.transaction(() => {
      const updated = this.repository.patch(id, fields)!;
      this.activity.add("lead_updated", `Lead updated: ${updated.name}`, id);
      return updated;
    });
  }

  approve(id: string): Lead { return this.updateStatus(id, "APPROVED"); }
  reject(id: string): Lead { return this.updateStatus(id, "SKIPPED"); }
  humanTakeover(id: string): Lead { return this.updateStatus(id, "HUMAN_TAKEOVER"); }

  retry(id: string): Lead {
    const lead = this.require(id);
    if (lead.status === "SENT" && lead.monitor_failures >= 3) {
      this.repository.resetRetry(id);
      this.activity.add("retried", `Reply check reset: ${lead.name}`, id);
      return this.require(id);
    }
    if (lead.status !== "FAILED" || lead.sent_at || lead.outreach_attempts >= 3) {
      throw new Error("Retry unavailable: only unsent FAILED leads with fewer than 3 attempts can retry");
    }
    const updated = this.updateStatus(id, "APPROVED");
    this.repository.resetRetry(id);
    this.activity.add("retried", `Outreach retried: ${lead.name}`, id);
    return updated;
  }

  claimOutreach(id: string): boolean { return this.repository.claimOutreach(id); }
  releaseOutreachClaim(id: string): void { this.repository.releaseOutreachClaim(id); }
  markError(id: string, message: string, errorClass: string | null = null): void { this.repository.markError(id, message, errorClass); }
  markChecked(id: string, error?: string, errorClass?: string, stop = false): void { this.repository.markChecked(id, error, errorClass, stop); }

  private require(id: string): Lead {
    const lead = this.repository.getById(id);
    if (!lead) throw new Error(`Lead not found: ${id}`);
    return lead;
  }

  private assertTemplate(id: string): void {
    if (!this.repository.db.prepare("SELECT 1 FROM templates WHERE id = ?").get(id)) throw new Error(`Template not found: ${id}`);
  }
}

function clean(value?: string): string | undefined { return value?.trim() || undefined; }
