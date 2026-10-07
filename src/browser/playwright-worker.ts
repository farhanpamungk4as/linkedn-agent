import { chromium, type Browser, type Page } from "playwright";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../config/logger.js";
import type { Lead } from "../leads/types.js";
import { MockBrowserWorker, type BrowserWorker } from "./worker.js";
import { BrowserActionError } from "./types.js";
import type { ConversationInspection, PreparedOutreach, ProfileInspection, ReplyStatus, SendResult, WorkerHealth } from "./types.js";
import { inspectProfilePage } from "../linkedin/profile.js";
import { openConversation, readConversation, sendMessage } from "../linkedin/messaging.js";
import { checkConversationReply } from "../linkedin/reply-monitor.js";

export class PlaywrightBrowserWorker implements BrowserWorker {
  readonly type = "playwright" as const;
  private browser: Browser | null = null;

  constructor(private readonly cdpUrl: string | undefined, private readonly logger: Logger,
    private readonly timezone = "Asia/Jakarta") {}

  async healthCheck(): Promise<WorkerHealth> {
    try {
      await this.connect();
      return { type: "playwright", online: Boolean(this.browser?.isConnected()), detail: "CDP connected" };
    } catch {
      return { type: "playwright", online: false, detail: "CDP unavailable" };
    }
  }

  async connect(): Promise<void> {
    if (this.browser?.isConnected()) return;
    if (!this.cdpUrl) throw new BrowserActionError("browser_offline", "BROWSER_CDP_URL is not configured");
    try {
      this.browser = await chromium.connectOverCDP(this.cdpUrl, { timeout: 10_000 });
      if (!this.browser.contexts().length) throw new Error("Existing browser has no default context");
      this.logger.info("Connected to existing Chromium via CDP");
    } catch {
      this.browser = null;
      throw new BrowserActionError("browser_offline", "Existing Chromium CDP is unavailable");
    }
  }

  async disconnect(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser?.isConnected()) await browser.close().catch(() => undefined);
  }

  async openLeadProfile(lead: Lead): Promise<ProfileInspection> {
    return this.withPage(lead, (page) => inspectProfilePage(page, lead));
  }
  async inspectLeadProfile(lead: Lead): Promise<ProfileInspection> { return this.openLeadProfile(lead); }

  async prepareOutreach(lead: Lead, message: string): Promise<PreparedOutreach> {
    return this.withPage(lead, async (page) => {
      const profile = await inspectProfilePage(page, lead);
      const root = await openConversation(page, lead.name);
      const conversation = await readConversation(root, null);
      if (conversation.previousOutreach) throw new BrowserActionError("previous_outreach", "Previous outbound message found");
      if (conversation.exists) throw new BrowserActionError("existing_conversation", "Existing conversation requires manual review");
      return { profileUrl: profile.profileUrl, profileName: profile.displayName, message };
    });
  }

  async prepareFollowUp(lead: Lead, message: string): Promise<PreparedOutreach> {
    return this.withPage(lead, async (page) => {
      const profile = await inspectProfilePage(page, lead);
      await openConversation(page, lead.name);
      return { profileUrl: profile.profileUrl, profileName: profile.displayName, message };
    });
  }

  async checkExistingConversation(lead: Lead): Promise<ConversationInspection> {
    return this.withPage(lead, async (page) => {
      await inspectProfilePage(page, lead);
      return readConversation(await openConversation(page, lead.name), lead.sent_at, this.timezone);
    });
  }
  async detectPreviousOutreach(lead: Lead): Promise<boolean> {
    return (await this.checkExistingConversation(lead)).previousOutreach;
  }

  async checkReplyStatus(lead: Lead): Promise<ReplyStatus> {
    if (!lead.sent_at) throw new BrowserActionError("unknown_layout", "Sent timestamp missing; reply timing cannot be verified");
    return this.withPage(lead, async (page) => {
      await inspectProfilePage(page, lead);
      return checkConversationReply(await openConversation(page, lead.name), lead.sent_at!, this.timezone);
    });
  }

  async sendApprovedOutreach(lead: Lead, message: string, allowExistingConversation = false): Promise<SendResult> {
    return this.withPage(lead, async (page) => {
      await inspectProfilePage(page, lead);
      const root = await openConversation(page, lead.name);
      const conversation = await readConversation(root, null);
      if (!allowExistingConversation && conversation.previousOutreach) throw new BrowserActionError("previous_outreach", "Previous outbound message found");
      if (!allowExistingConversation && conversation.exists) throw new BrowserActionError("existing_conversation", "Existing conversation requires manual review");
      return sendMessage(root, message);
    });
  }

  async performOutreach(_lead: Lead, _message: string): Promise<{ mode: "mock" }> {
    throw new BrowserActionError("unknown_layout", "Playwright send requires a persisted approved pending action");
  }

  private async withPage<T>(lead: Lead, action: (page: Page) => Promise<T>): Promise<T> {
    await this.connect();
    const context = this.browser!.contexts()[0];
    if (!context) throw new BrowserActionError("browser_offline", "Existing browser context unavailable");
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    try {
      let navigated = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await page.goto(lead.linkedin_url, { waitUntil: "domcontentloaded", timeout: 15_000 });
          navigated = true;
          break;
        } catch {
          if (attempt === 1) throw new BrowserActionError("temporary_navigation", "LinkedIn profile navigation failed twice");
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      if (!navigated) throw new BrowserActionError("temporary_navigation", "LinkedIn profile navigation failed");
      return await action(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

export function createBrowserWorker(config: AppConfig, logger: Logger): BrowserWorker {
  return config.browserWorker === "playwright"
    ? new PlaywrightBrowserWorker(config.browserCdpUrl, logger, config.timezone)
    : new MockBrowserWorker(logger);
}
