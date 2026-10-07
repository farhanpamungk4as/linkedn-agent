import type { DatabaseSync } from "node:sqlite";
import { ActivityService } from "../activity/service.js";

export interface Settings {
  paused: boolean;
  outreach_enabled: boolean;
  monitor_enabled: boolean;
}

export interface JobRun {
  name: "outreach" | "replies";
  last_started_at: string | null;
  last_finished_at: string | null;
  last_status: string | null;
  last_error: string | null;
}

export class SystemService {
  readonly activity: ActivityService;
  constructor(private readonly db: DatabaseSync) { this.activity = new ActivityService(db); }

  getSettings(): Settings {
    const row = this.db.prepare("SELECT paused, outreach_enabled, monitor_enabled FROM system_settings WHERE id = 1").get() as {
      paused: number; outreach_enabled: number; monitor_enabled: number;
    };
    return { paused: Boolean(row.paused), outreach_enabled: Boolean(row.outreach_enabled), monitor_enabled: Boolean(row.monitor_enabled) };
  }
  setPaused(paused: boolean): Settings {
    const before = this.getSettings();
    if (before.paused === paused) return before;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE system_settings SET paused = ? WHERE id = 1").run(paused ? 1 : 0);
      this.activity.add(paused ? "system_paused" : "system_resumed", paused ? "System paused" : "System resumed");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.getSettings();
  }
  setEnabled(job: "outreach" | "monitor", enabled: boolean): Settings {
    const column = job === "outreach" ? "outreach_enabled" : "monitor_enabled";
    this.db.prepare(`UPDATE system_settings SET ${column} = ? WHERE id = 1`).run(enabled ? 1 : 0);
    this.activity.add("system_setting_changed", `${job} ${enabled ? "enabled" : "disabled"}`);
    return this.getSettings();
  }
  getTelegramOffset(): number {
    return (this.db.prepare("SELECT telegram_offset FROM system_settings WHERE id = 1").get() as { telegram_offset: number }).telegram_offset;
  }
  setTelegramOffset(offset: number): void {
    this.db.prepare("UPDATE system_settings SET telegram_offset = ? WHERE id = 1 AND telegram_offset < ?").run(offset, offset);
  }
  jobRuns(): JobRun[] {
    return this.db.prepare("SELECT * FROM job_runs ORDER BY name").all() as unknown as JobRun[];
  }
  jobStarted(name: JobRun["name"]): void {
    this.db.prepare("UPDATE job_runs SET last_started_at = ?, last_status = 'RUNNING', last_error = NULL WHERE name = ?")
      .run(new Date().toISOString(), name);
  }
  jobFinished(name: JobRun["name"], status: string, error?: string): void {
    this.db.prepare("UPDATE job_runs SET last_finished_at = ?, last_status = ?, last_error = ? WHERE name = ?")
      .run(new Date().toISOString(), status, error?.slice(0, 500) ?? null, name);
  }
}
