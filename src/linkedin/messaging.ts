import type { Locator, Page } from "playwright";
import { BrowserActionError } from "../browser/types.js";
import type { ConversationInspection, SendResult } from "../browser/types.js";
import { MESSAGE_ACTION, SELECTORS, SEND_ACTION } from "./selectors.js";

export interface MessageSnapshot { direction: "incoming" | "outgoing" | "unknown"; text: string; sentAt: string | null; }
export interface ConversationSnapshot { resolved: boolean; emptyIndicator: boolean; recipientName: string; messages: MessageSnapshot[]; }

interface DateParts { year: number; month: number; day: number; hour: number; minute: number; }

function zonedParts(date: Date, timezone: string): DateParts {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute) };
}

function localPartsToIso(parts: DateParts, timezone: string): string {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let timestamp = desired;
  for (let attempt = 0; attempt < 3; attempt++) {
    const observed = zonedParts(new Date(timestamp), timezone);
    const observedValue = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
    timestamp += desired - observedValue;
  }
  return new Date(timestamp).toISOString();
}

export function parseLinkedInMessageTime(
  dateLabel: string, timeLabel: string, now = new Date(), timezone = "Asia/Jakarta",
): string | null {
  const current = zonedParts(now, timezone);
  const base = new Date(Date.UTC(current.year, current.month - 1, current.day));
  const dateText = dateLabel.trim().toLocaleLowerCase("en-US");
  let date = new Date(base);
  if (dateText === "today") {
    // Keep the current local date.
  } else if (dateText === "yesterday") {
    date.setUTCDate(date.getUTCDate() - 1);
  } else {
    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const weekday = weekdays.indexOf(dateText);
    if (weekday >= 0) {
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - weekday + 7) % 7));
    } else {
      const match = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?$/i.exec(dateLabel.trim());
      if (!match) return null;
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const month = months.indexOf(match[1]!.slice(0, 3).toLocaleLowerCase("en-US"));
      let year = match[3] ? Number(match[3]) : current.year;
      date = new Date(Date.UTC(year, month, Number(match[2])));
      if (!match[3] && date.getTime() > base.getTime()) {
        year--;
        date = new Date(Date.UTC(year, month, Number(match[2])));
      }
    }
  }
  const time = /^(\d{1,2})[:.]([0-5]\d)\s*(AM|PM)?$/i.exec(timeLabel.trim());
  if (!time) return null;
  let hour = Number(time[1]);
  if (time[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (time[3].toUpperCase() === "PM" ? 12 : 0);
  } else if (hour > 23) return null;
  return localPartsToIso({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
    day: date.getUTCDate(), hour, minute: Number(time[2]) }, timezone);
}

export function inspectConversationSnapshot(snapshot: ConversationSnapshot, sentAt: string | null): ConversationInspection {
  if (!snapshot.resolved) throw new BrowserActionError("unknown_layout", "Conversation panel not found");
  if (!snapshot.messages.length && !snapshot.emptyIndicator) throw new BrowserActionError("unknown_layout", "Cannot confirm conversation is empty");
  // During outreach preparation, any existing message is enough to stop safely.
  // Sender direction and timestamps are only required by reply monitoring.
  if (!sentAt && snapshot.messages.length) {
    return {
      exists: true,
      previousOutreach: snapshot.messages.some((item) => item.direction === "outgoing"),
      repliedAfterSent: false,
      messages: snapshot.messages,
      reply: null,
      conversationUrl: null,
    };
  }
  if (snapshot.messages.some((item) => item.direction === "unknown")) throw new BrowserActionError("unknown_layout", "Cannot determine message sender");
  if (sentAt && snapshot.messages.some((item) => !item.sentAt || Number.isNaN(Date.parse(item.sentAt)))) {
    throw new BrowserActionError("unknown_layout", "Cannot determine message time");
  }
  const sentMillis = sentAt ? Date.parse(sentAt) : Number.NaN;
  const sentMinute = Math.floor(sentMillis / 60_000);
  const reply = sentAt ? snapshot.messages.reduce<MessageSnapshot | null>((found, item, index) => {
    if (item.direction !== "incoming" || !item.sentAt) return found;
    const incomingMillis = Date.parse(item.sentAt);
    if (incomingMillis > sentMillis) return item;
    // LinkedIn commonly exposes only minute precision. If an outgoing message in
    // the send minute appears first, a following incoming item in that minute is a reply.
    const sameMinute = Math.floor(incomingMillis / 60_000) === sentMinute;
    const outreachBefore = sameMinute && snapshot.messages.slice(0, index).some((candidate) =>
      candidate.direction === "outgoing" && candidate.sentAt &&
      Math.floor(Date.parse(candidate.sentAt) / 60_000) === sentMinute);
    return outreachBefore ? item : found;
  }, null) : null;
  return {
    exists: snapshot.messages.length > 0,
    previousOutreach: snapshot.messages.some((item) => item.direction === "outgoing"),
    repliedAfterSent: Boolean(reply),
    messages: snapshot.messages,
    reply,
    conversationUrl: null,
  };
}

export async function openConversation(page: Page, expectedName: string): Promise<Locator> {
  const actions = page.getByRole("button", { name: MESSAGE_ACTION }).or(page.getByRole("link", { name: MESSAGE_ACTION }));
  if (await actions.count() !== 1) throw new BrowserActionError("unknown_layout", "Unique Message action not found");
  const composeHref = await actions.first().getAttribute("href");
  await actions.click({ timeout: 5000 });
  let root = page.locator(SELECTORS.conversationRoot).filter({ visible: true });
  let confirmedNewCompose = false;
  const overlayOpened = await root.first().waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  // Some LinkedIn layouts ignore the profile-page overlay link in a fresh CDP tab.
  // Fall back to the full Messaging page and open the exact existing conversation.
  if (!overlayOpened) {
    await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 15_000 });
    const search = page.locator(`${SELECTORS.messageSearch}:visible`);
    await search.first().waitFor({ state: "visible", timeout: 7000 }).catch(() => {
      throw new BrowserActionError("unknown_layout", "Message search field did not load");
    });
    if (await search.count() !== 1) throw new BrowserActionError("unknown_layout", "Unique message search field not found");
    await search.fill(expectedName);
    await search.press("Enter");

    const exactHeading = page.locator(SELECTORS.conversationCard)
      .getByRole("heading", { name: expectedName, exact: true });
    const resultFound = await exactHeading.first().waitFor({ state: "visible", timeout: 7000 })
      .then(() => true)
      .catch(() => false);
    if (resultFound) {
      if (await exactHeading.count() !== 1) throw new BrowserActionError("unknown_layout", "Conversation search result is ambiguous");
      await exactHeading.click({ timeout: 5000 });
    } else {
      if (!composeHref) throw new BrowserActionError("unknown_layout", "Message compose link not found");
      await page.goto(new URL(composeHref, "https://www.linkedin.com").toString(), {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      const recipients = page.locator(SELECTORS.composeRecipient).filter({ visible: true });
      await recipients.first().waitFor({ state: "visible", timeout: 7000 }).catch(() => {
        throw new BrowserActionError("unknown_layout", "Compose recipient did not load");
      });
      const recipientNames = (await recipients.allInnerTexts()).map((value) => value.trim().toLocaleLowerCase());
      if (recipientNames.length !== 1 || recipientNames[0] !== expectedName.trim().toLocaleLowerCase()) {
        throw new BrowserActionError("profile_mismatch", "Compose recipient did not match lead");
      }
      confirmedNewCompose = true;
    }

    root = page.locator(SELECTORS.messagingConversationRoot)
      .filter({ has: page.locator(SELECTORS.composer), visible: true });
    await root.first().waitFor({ state: "visible", timeout: 7000 }).catch(() => {
      throw new BrowserActionError("unknown_layout", "Messaging conversation did not open");
    });
  }

  if (await root.count() !== 1) throw new BrowserActionError("unknown_layout", "Conversation panel is ambiguous");
  if (confirmedNewCompose) {
    const eventCount = await root.locator(SELECTORS.messageEvents).count();
    if (eventCount === 0) {
      await root.evaluate((element) => element.setAttribute("data-linkedin-agent-confirmed-empty", "true"));
    }
    return root;
  }
  const heading = (await root.locator("h2, h3").first().textContent({ timeout: 3000 }))?.trim() ?? "";
  if (!heading.toLocaleLowerCase().includes(expectedName.toLocaleLowerCase())) {
    throw new BrowserActionError("profile_mismatch", "Conversation recipient did not match lead");
  }
  return root;
}

export async function readConversation(
  root: Locator, sentAt: string | null, timezone = "Asia/Jakarta", now = new Date(),
): Promise<ConversationInspection> {
  if (await root.getAttribute("data-linkedin-agent-confirmed-empty") === "true") {
    if (sentAt) throw new BrowserActionError("temporary_navigation", "Sent conversation has not appeared in Messaging yet");
    return inspectConversationSnapshot({ resolved: true, emptyIndicator: true, recipientName: "", messages: [] }, null);
  }
  const eventLocator = root.locator(SELECTORS.messageEvents);
  const count = await eventLocator.count();
  if (count > 100) throw new BrowserActionError("unknown_layout", "Conversation has too many visible messages to verify safely");
  const messages: MessageSnapshot[] = [];
  let dateLabel = "";
  let groupTimeLabel = "";
  for (let index = 0; index < count; index++) {
    const event = eventLocator.nth(index);
    const heading = (await event.locator(SELECTORS.dateHeading).first().textContent().catch(() => null))?.trim();
    if (heading) dateLabel = heading;
    const item = event.locator(SELECTORS.messageItem);
    const itemCount = await item.count();
    if (itemCount === 0) continue;
    const incoming = await event.locator(SELECTORS.incomingMessage).count() > 0;
    const senderCount = await event.locator(SELECTORS.messageSender).count();
    const sentMarker = await event.locator(SELECTORS.sentIndicator).count() > 0;
    const direction = itemCount > 0 && incoming ? "incoming" : itemCount > 0 && (senderCount > 0 || sentMarker) ? "outgoing" : "unknown";
    const nativeTime = await event.locator(SELECTORS.messageTime).first().getAttribute("datetime").catch(() => null);
    const visibleTime = (await event.locator(SELECTORS.groupTimestamp).first().textContent().catch(() => null))?.trim() ?? "";
    if (visibleTime) groupTimeLabel = visibleTime;
    const parsedTime = nativeTime || (dateLabel && groupTimeLabel ? parseLinkedInMessageTime(dateLabel, groupTimeLabel, now, timezone) : null);
    const bodies = await event.locator(SELECTORS.messageBody).allTextContents();
    messages.push({ direction, text: bodies.map((value) => value.trim()).filter(Boolean).join("\n"), sentAt: parsedTime });
  }
  // A composer placeholder can say "send a message" even when history did not load.
  // Only a dedicated empty-list marker is enough evidence to prepare a new send.
  const emptyIndicator = await root.locator(SELECTORS.emptyConversation).count() === 1;
  const inspection = inspectConversationSnapshot({ resolved: true, emptyIndicator,
    recipientName: "", messages }, sentAt);
  const pageUrl = root.page().url();
  inspection.conversationUrl = /^https:\/\/(?:www\.)?linkedin\.com\/messaging\//.test(pageUrl) ? pageUrl : null;
  return inspection;
}

export async function sendMessage(root: Locator, message: string): Promise<SendResult> {
  const composer = root.locator(SELECTORS.composer);
  if (await composer.count() !== 1) throw new BrowserActionError("unknown_layout", "Unique message composer not found");
  const send = root.getByRole("button", { name: SEND_ACTION });
  if (await send.count() !== 1) throw new BrowserActionError("unknown_layout", "Unique Send button not found");
  const normalize = (value: string) => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const expected = normalize(message);
  const matchingOutgoingCount = async () => {
    const events = root.locator(SELECTORS.messageEvents);
    let matches = 0;
    for (let index = Math.max(0, (await events.count()) - 30); index < await events.count(); index++) {
      const event = events.nth(index);
      if (await event.locator(SELECTORS.incomingMessage).count()) continue;
      const bodies = await event.locator(SELECTORS.messageBody).allTextContents();
      if (bodies.some((body) => normalize(body) === expected)) matches++;
    }
    return matches;
  };
  const beforeCount = await matchingOutgoingCount();
  await composer.fill(message);
  if (normalize(await composer.innerText()) !== expected) throw new BrowserActionError("unknown_layout", "Composer text did not match approved message");
  try { await send.click({ timeout: 5000 }); }
  catch { throw new BrowserActionError("send_uncertain", "Send click may have completed; inspect conversation manually"); }
  // LinkedIn can render a message event before its sent indicator. Verify a new,
  // exact outgoing bubble rather than relying on the button click result alone.
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await matchingOutgoingCount() > beforeCount) return { status: "sent" };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { status: "uncertain" };
}
