import type { Locator } from "playwright";
import type { ReplyStatus } from "../browser/types.js";
import { readConversation } from "./messaging.js";

export async function checkConversationReply(root: Locator, sentAt: string, timezone: string): Promise<ReplyStatus> {
  const conversation = await readConversation(root, sentAt, timezone);
  return { replied: conversation.repliedAfterSent, checkedAt: new Date().toISOString(),
    messages: conversation.messages, reply: conversation.reply, conversationUrl: conversation.conversationUrl };
}
