import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ConversationDirection, ConversationMessage, Lead, LeadPatch, LeadStatus, NewLead } from "./types.js";

export class LeadRepository {
  constructor(readonly db: DatabaseSync) {}

  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  create(input: NewLead): Lead {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO leads (id, name, linkedin_url, company, job_title, location, score, score_reason, status, template_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, ?, ?)
    `).run(id, input.name, input.linkedin_url, input.company ?? null, input.job_title ?? null,
      input.location ?? null, input.score ?? null, input.score_reason ?? null, input.template_id ?? null, now, now);
    return this.getById(id)!;
  }

  list(): Lead[] {
    return this.db.prepare("SELECT * FROM leads ORDER BY created_at DESC, id DESC").all() as unknown as Lead[];
  }

  getById(id: string): Lead | undefined {
    return this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as unknown as Lead | undefined;
  }

  getByStatus(status: LeadStatus): Lead[] {
    return this.db.prepare("SELECT * FROM leads WHERE status = ? ORDER BY created_at, id").all(status) as unknown as Lead[];
  }

  listConversationMessages(leadId: string): ConversationMessage[] {
    return this.db.prepare(`SELECT * FROM conversation_messages WHERE lead_id = ?
      ORDER BY sent_at ASC, observed_at ASC, rowid ASC`).all(leadId) as unknown as ConversationMessage[];
  }

  recordConversationMessage(
    leadId: string, direction: ConversationDirection, body: string, sentAt: string,
    source: ConversationMessage["source"],
  ): ConversationMessage | undefined {
    const text = body.trim();
    if (!text || Number.isNaN(Date.parse(sentAt))) return undefined;
    const nearDuplicate = (this.db.prepare(`SELECT * FROM conversation_messages
      WHERE lead_id = ? AND direction = ? AND body = ? ORDER BY sent_at DESC`)
      .all(leadId, direction, text.slice(0, 8000)) as unknown as ConversationMessage[])
      .find((message) => Math.abs(Date.parse(message.sent_at) - Date.parse(sentAt)) < 120_000);
    if (nearDuplicate) return nearDuplicate;
    const item: ConversationMessage = {
      id: randomUUID(), lead_id: leadId, direction, body: text.slice(0, 8000), sent_at: sentAt,
      observed_at: new Date().toISOString(), source,
    };
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO conversation_messages
      (id, lead_id, direction, body, sent_at, observed_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(item.id, item.lead_id, item.direction, item.body, item.sent_at, item.observed_at, item.source);
    if (direction === "incoming" && inserted.changes === 1) {
      this.db.prepare("UPDATE leads SET human_handled_at = NULL, updated_at = ? WHERE id = ? AND human_handled_at IS NOT NULL")
        .run(item.observed_at, leadId);
    }
    return this.db.prepare(`SELECT * FROM conversation_messages
      WHERE lead_id = ? AND direction = ? AND body = ? AND sent_at = ?`)
      .get(leadId, direction, item.body, sentAt) as unknown as ConversationMessage | undefined;
  }

  markHumanHandled(id: string): Lead | undefined {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE leads SET human_handled_at = ?, updated_at = ?
      WHERE id = ? AND status = 'HUMAN_TAKEOVER'`).run(now, now, id);
    return result.changes === 1 ? this.getById(id) : undefined;
  }

  setConversationUrl(id: string, value: string | null): void {
    this.db.prepare("UPDATE leads SET conversation_url = COALESCE(?, conversation_url) WHERE id = ?").run(value, id);
  }

  updateStatus(id: string, status: LeadStatus): Lead | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE leads SET status = ?, updated_at = ?,
        approved_at = CASE WHEN ? = 'APPROVED' THEN COALESCE(approved_at, ?) ELSE approved_at END,
        sent_at = CASE WHEN ? = 'SENT' THEN COALESCE(sent_at, ?) ELSE sent_at END,
        replied_at = CASE WHEN ? = 'REPLIED' THEN COALESCE(replied_at, ?) ELSE replied_at END,
        outreach_claimed_at = CASE WHEN ? IN ('SENT', 'FAILED') THEN NULL ELSE outreach_claimed_at END,
        error_message = CASE WHEN ? = 'APPROVED' THEN NULL ELSE error_message END,
        error_class = CASE WHEN ? = 'APPROVED' THEN NULL ELSE error_class END
      WHERE id = ? AND status = ?
    `).run(status, now, status, now, status, now, status, now, status, status, status, id, existing.status);
    if (result.changes !== 1) throw new Error("Lead changed concurrently; refresh and try again");
    return this.getById(id);
  }

  patch(id: string, fields: LeadPatch): Lead | undefined {
    if (!this.getById(id)) return undefined;
    const keys = Object.keys(fields) as (keyof LeadPatch)[];
    if (keys.length === 0) return this.getById(id);
    const values = keys.map((key) => fields[key] ?? null);
    this.db.prepare(`UPDATE leads SET ${keys.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...values, new Date().toISOString(), id);
    return this.getById(id);
  }

  claimOutreach(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE leads SET outreach_claimed_at = ?, outreach_attempts = outreach_attempts + 1, updated_at = ?
      WHERE id = ? AND status = 'APPROVED' AND outreach_claimed_at IS NULL AND sent_at IS NULL AND outreach_attempts < 3
    `).run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes === 1;
  }

  releaseOutreachClaim(id: string): void {
    this.db.prepare("UPDATE leads SET outreach_claimed_at = NULL, updated_at = ? WHERE id = ? AND status = 'APPROVED'")
      .run(new Date().toISOString(), id);
  }

  markError(id: string, message: string, errorClass: string | null = null): void {
    this.db.prepare("UPDATE leads SET error_message = ?, error_class = ?, updated_at = ? WHERE id = ?")
      .run(message.slice(0, 500), errorClass, new Date().toISOString(), id);
  }

  markChecked(id: string, error?: string, errorClass?: string, stop = false): void {
    this.db.prepare(`UPDATE leads SET last_checked_at = ?, updated_at = ?, error_message = ?, error_class = ?,
      monitor_failures = CASE WHEN ? = 1 THEN 3 WHEN ? IS NULL THEN 0 ELSE monitor_failures + 1 END WHERE id = ?`)
      .run(new Date().toISOString(), new Date().toISOString(), error ?? null, errorClass ?? null, stop ? 1 : 0, error ?? null, id);
  }

  resetRetry(id: string): void {
    this.db.prepare("UPDATE leads SET outreach_claimed_at = NULL, error_message = NULL, error_class = NULL, monitor_failures = 0, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }
}
