import type { AppConfig } from "../config/index.js";
import type { Logger } from "../config/logger.js";
import type { BrowserWorker } from "../browser/worker.js";
import type { LeadService } from "../leads/service.js";
import type { ReplyDetector } from "../monitor/workflow.js";
import { runMockReplyMonitor } from "../monitor/workflow.js";
import { runMockOutreach } from "../outreach/workflow.js";
import { runProductionOutreach } from "../outreach/production.js";
import { runProductionReplyMonitor } from "../monitor/production.js";
import type { PendingActionService } from "../outreach/pending.js";
import type { SystemService } from "../system/service.js";
import type { Notifier } from "../telegram/notifier.js";
import type { TemplateService } from "../templates/service.js";

type JobName = "outreach" | "replies";

export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<JobName>();
  private readonly next: Record<JobName, string | null> = { outreach: null, replies: null };
  private readonly active = new Set<Promise<unknown>>();
  private workerOnline: boolean | null = null;
  private stopping = false;

  constructor(
    private readonly config: AppConfig,
    private readonly system: SystemService,
    private readonly leads: LeadService,
    private readonly templates: TemplateService,
    private readonly worker: BrowserWorker,
    private readonly detector: ReplyDetector,
    private readonly notifier: Notifier,
    private readonly logger: Logger,
    private readonly pending?: PendingActionService,
  ) {}

  start(): void {
    if (this.timers.length) return;
    this.stopping = false;
    this.schedule("outreach", this.config.outreachInterval);
    this.schedule("replies", this.config.replyMonitorInterval);
    if (this.config.automationEnabled) {
      void this.refreshWorkerHealth();
      this.timers.push(setInterval(() => { void this.refreshWorkerHealth(); }, 60_000));
    }
    this.logger.info("Scheduler started", { outreachSeconds: this.config.outreachInterval, replySeconds: this.config.replyMonitorInterval });
  }

  stop(): void {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.next.outreach = null;
    this.next.replies = null;
  }

  async shutdown(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.active]);
    await this.worker.disconnect();
  }

  status() {
    const settings = this.system.getSettings();
    return {
      health: this.timers.length ? "RUNNING" : "STOPPED",
      worker_health: !this.config.automationEnabled ? "DISABLED" : this.workerOnline === null ? "CHECKING" : this.workerOnline ? "ONLINE" : "OFFLINE",
      worker_type: this.worker.type,
      automation_enabled: this.config.automationEnabled,
      running_jobs: [...this.running],
      next_run: { ...this.next },
      intervals_seconds: { outreach: this.config.outreachInterval, replies: this.config.replyMonitorInterval },
      enabled: { outreach: settings.outreach_enabled && this.config.outreachEnabled, replies: settings.monitor_enabled && this.config.monitorEnabled },
      last_runs: this.system.jobRuns(),
    };
  }

  async run(name: JobName): Promise<{ status: "completed" | "skipped"; reason?: string; result?: unknown }> {
    const settings = this.system.getSettings();
    if (this.stopping) return { status: "skipped", reason: "Scheduler stopping" };
    if (!this.config.automationEnabled) return { status: "skipped", reason: "AUTOMATION_ENABLED=false" };
    if (settings.paused) return { status: "skipped", reason: "System paused" };
    if (name === "outreach" && (!settings.outreach_enabled || !this.config.outreachEnabled)) {
      return { status: "skipped", reason: "Outreach disabled" };
    }
    if (name === "replies" && (!settings.monitor_enabled || !this.config.monitorEnabled)) {
      return { status: "skipped", reason: "Reply monitor disabled" };
    }
    if (this.running.has(name)) return { status: "skipped", reason: "Job already running" };
    this.running.add(name);
    const task = this.execute(name);
    this.active.add(task);
    try { return await task; }
    finally { this.active.delete(task); this.running.delete(name); }
  }

  private async execute(name: JobName): Promise<{ status: "completed" | "skipped"; reason?: string; result?: unknown }> {
    if (this.worker.type === "playwright") {
      await this.refreshWorkerHealth();
      if (!this.workerOnline) {
        this.system.activity.add("browser_offline", "CDP unavailable; job deferred");
        return { status: "skipped", reason: "Browser offline" };
      }
    }
    this.system.jobStarted(name);
    this.system.activity.add("scheduler_run", `${name} job started`);
    try {
      const result = name === "outreach"
        ? this.worker.type === "mock"
          ? await runMockOutreach(this.leads, this.templates, this.worker, this.notifier, this.logger)
          : await runProductionOutreach(this.config, this.system, this.leads, this.templates, this.requirePending(), this.worker, this.notifier, this.logger)
        : this.worker.type === "mock"
          ? await runMockReplyMonitor(this.leads, this.detector, this.notifier, this.logger)
          : await runProductionReplyMonitor(this.config, this.system, this.leads, this.worker, this.notifier, this.logger);
      this.system.jobFinished(name, "SUCCESS");
      this.system.activity.add("scheduler_run", `${name} job completed`);
      return { status: "completed", result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.system.jobFinished(name, "FAILED", message);
      this.system.activity.add("scheduler_run", `${name} job failed`);
      this.logger.error("Job failed", { job: name, error: message });
      throw error;
    }
  }

  private requirePending(): PendingActionService {
    if (!this.pending) throw new Error("Pending action service is unavailable");
    return this.pending;
  }

  private async refreshWorkerHealth(): Promise<void> {
    if (!this.config.automationEnabled) { this.workerOnline = false; return; }
    let online = false;
    try { online = (await this.worker.healthCheck()).online; }
    catch (error) { this.logger.warn("Browser health check failed", { error: error instanceof Error ? error.message : String(error) }); }
    const before = this.workerOnline;
    this.workerOnline = online;
    if (this.worker.type !== "playwright" || before === online) return;
    const message = online ? "✅ Playwright terhubung kembali ke browser." : "⚠️ Playwright terputus dari browser. Job ditunda sampai koneksi pulih.";
    this.system.activity.add(online ? "browser_online" : "browser_offline", message);
    try { await this.notifier.notify(message); }
    catch { this.logger.warn("Browser health notification failed"); }
  }

  private schedule(name: JobName, seconds: number): void {
    const duration = seconds * 1000;
    this.next[name] = new Date(Date.now() + duration).toISOString();
    const timer = setInterval(() => {
      this.next[name] = new Date(Date.now() + duration).toISOString();
      void this.run(name).catch(() => undefined);
    }, duration);
    this.timers.push(timer);
  }
}
