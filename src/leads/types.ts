export const LEAD_STATUSES = [
  "NEW",
  "QUALIFIED",
  "APPROVED",
  "SENT",
  "REPLIED",
  "HUMAN_TAKEOVER",
  "SKIPPED",
  "FAILED",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type ConversationDirection = "outgoing" | "incoming";

export interface ConversationMessage {
  id: string;
  lead_id: string;
  direction: ConversationDirection;
  body: string;
  sent_at: string;
  observed_at: string;
  source: "playwright" | "manual" | "linkedin";
}

export interface Lead {
  id: string;
  name: string;
  linkedin_url: string;
  company: string | null;
  job_title: string | null;
  location: string | null;
  status: LeadStatus;
  score: number | null;
  score_reason: string | null;
  template_id: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  sent_at: string | null;
  replied_at: string | null;
  last_checked_at: string | null;
  error_message: string | null;
  error_class: string | null;
  outreach_claimed_at: string | null;
  outreach_attempts: number;
  monitor_failures: number;
  human_handled_at: string | null;
  conversation_url: string | null;
}

export interface NewLead {
  name: string;
  linkedin_url: string;
  company?: string;
  job_title?: string;
  location?: string;
  score?: number | null;
  score_reason?: string | null;
  template_id?: string;
}

export type LeadPatch = Partial<{
  name: string | null;
  company: string | null;
  job_title: string | null;
  location: string | null;
  score: number | null;
  score_reason: string | null;
  template_id: string | null;
}>;

export function parseLeadStatus(value: string): LeadStatus {
  if (!LEAD_STATUSES.includes(value as LeadStatus)) {
    throw new Error(`Invalid status: ${value}. Use: ${LEAD_STATUSES.join(", ")}`);
  }
  return value as LeadStatus;
}
