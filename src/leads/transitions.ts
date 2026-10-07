import type { Lead, LeadStatus } from "./types.js";

const allowed: Record<LeadStatus, readonly LeadStatus[]> = {
  NEW: ["QUALIFIED", "SKIPPED", "FAILED"],
  QUALIFIED: ["APPROVED", "SKIPPED", "FAILED"],
  APPROVED: ["SENT", "SKIPPED", "FAILED"],
  SENT: ["REPLIED"],
  REPLIED: ["HUMAN_TAKEOVER"],
  HUMAN_TAKEOVER: [],
  SKIPPED: [],
  FAILED: ["APPROVED"],
};

export function assertTransition(lead: Lead, next: LeadStatus): void {
  if (!allowed[lead.status].includes(next)) {
    throw new Error(`Invalid transition: ${lead.status} → ${next}`);
  }
  if (lead.status === "FAILED" && next === "APPROVED" && lead.sent_at) {
    throw new Error("Cannot retry outreach after a message was sent");
  }
  if (lead.status === "FAILED" && next === "APPROVED" && lead.outreach_attempts >= 3) {
    throw new Error("Cannot retry outreach after 3 attempts");
  }
}

export function canTransition(lead: Lead, next: LeadStatus): boolean {
  try { assertTransition(lead, next); return true; } catch { return false; }
}
