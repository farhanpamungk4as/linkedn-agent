export type BrowserErrorKind = "browser_offline" | "temporary_navigation" | "auth_challenge" | "unknown_layout" | "profile_mismatch" | "existing_conversation" | "previous_outreach" | "send_uncertain";

export class BrowserActionError extends Error {
  constructor(readonly kind: BrowserErrorKind, message: string) { super(message); this.name = "BrowserActionError"; }
  get requiresHuman(): boolean { return !["browser_offline", "temporary_navigation"].includes(this.kind); }
}

export interface WorkerHealth { type: "mock" | "playwright"; online: boolean; detail: string; }
export interface ProfileInspection { profileUrl: string; displayName: string; verified: true; }
export interface ObservedConversationMessage {
  direction: "incoming" | "outgoing" | "unknown";
  text: string;
  sentAt: string | null;
}
export interface ConversationInspection {
  exists: boolean;
  previousOutreach: boolean;
  repliedAfterSent: boolean;
  messages: ObservedConversationMessage[];
  reply: ObservedConversationMessage | null;
  conversationUrl: string | null;
}
export interface PreparedOutreach { profileUrl: string; profileName: string; message: string; }
export interface SendResult { status: "sent" | "uncertain"; }
export interface ReplyStatus {
  replied: boolean;
  checkedAt: string;
  messages: ObservedConversationMessage[];
  reply: ObservedConversationMessage | null;
  conversationUrl: string | null;
}
