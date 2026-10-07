import type { Lead } from "../leads/types.js";
import type { Logger } from "../config/logger.js";
import type { ConversationInspection, PreparedOutreach, ProfileInspection, ReplyStatus, SendResult, WorkerHealth } from "./types.js";

export interface BrowserWorker {
  readonly type: "mock" | "playwright";
  healthCheck(): Promise<WorkerHealth>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  openLeadProfile(lead: Lead): Promise<ProfileInspection>;
  inspectLeadProfile(lead: Lead): Promise<ProfileInspection>;
  prepareOutreach(lead: Lead, message: string): Promise<PreparedOutreach>;
  prepareFollowUp(lead: Lead, message: string): Promise<PreparedOutreach>;
  checkExistingConversation(lead: Lead): Promise<ConversationInspection>;
  detectPreviousOutreach(lead: Lead): Promise<boolean>;
  checkReplyStatus(lead: Lead): Promise<ReplyStatus>;
  sendApprovedOutreach(lead: Lead, message: string, allowExistingConversation?: boolean): Promise<SendResult>;
  // Kept for the existing mock workflow and tests.
  performOutreach(lead: Lead, message: string): Promise<{ mode: "mock" }>;
}

// Local simulation; this worker never opens a browser.
export class MockBrowserWorker implements BrowserWorker {
  readonly type = "mock" as const;
  constructor(private readonly logger: Logger) {}

  async healthCheck(): Promise<WorkerHealth> { return { type: "mock", online: true, detail: "Mock worker ready" }; }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async openLeadProfile(lead: Lead): Promise<ProfileInspection> {
    return { profileUrl: lead.linkedin_url, displayName: lead.name, verified: true };
  }
  async inspectLeadProfile(lead: Lead): Promise<ProfileInspection> { return this.openLeadProfile(lead); }
  async prepareOutreach(lead: Lead, message: string): Promise<PreparedOutreach> {
    return { profileUrl: lead.linkedin_url, profileName: lead.name, message };
  }
  async prepareFollowUp(lead: Lead, message: string): Promise<PreparedOutreach> {
    return { profileUrl: lead.linkedin_url, profileName: lead.name, message };
  }
  async checkExistingConversation(_lead: Lead): Promise<ConversationInspection> {
    return { exists: false, previousOutreach: false, repliedAfterSent: false, messages: [], reply: null, conversationUrl: null };
  }
  async detectPreviousOutreach(_lead: Lead): Promise<boolean> { return false; }
  async checkReplyStatus(_lead: Lead): Promise<ReplyStatus> {
    const reply = { direction: "incoming" as const, text: "Mock reply", sentAt: new Date().toISOString() };
    return { replied: true, checkedAt: new Date().toISOString(), messages: [reply], reply, conversationUrl: null };
  }
  async sendApprovedOutreach(lead: Lead, message: string, _allowExistingConversation = false): Promise<SendResult> {
    await this.performOutreach(lead, message);
    return { status: "sent" };
  }

  async performOutreach(lead: Lead, message: string): Promise<{ mode: "mock" }> {
    this.logger.info("Mock browser outreach completed", { leadId: lead.id, characters: message.length });
    return { mode: "mock" };
  }
}
