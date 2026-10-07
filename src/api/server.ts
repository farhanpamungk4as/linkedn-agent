import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../config/logger.js";
import type { LeadService } from "../leads/service.js";
import { LEAD_STATUSES, parseLeadStatus, type LeadPatch } from "../leads/types.js";
import type { Scheduler } from "../scheduler/index.js";
import type { SystemService } from "../system/service.js";
import type { TemplateService } from "../templates/service.js";
import { renderTemplate } from "../templates/service.js";
import type { Notifier } from "../telegram/notifier.js";
import { AuthService } from "../auth/service.js";
import type { PendingActionService, PendingState } from "../outreach/pending.js";
import { approveAndSend, prepareFollowUp } from "../outreach/production.js";
import type { BrowserWorker } from "../browser/worker.js";
import type { HermesClient } from "../hermes/client.js";
import { syncLeadConversation } from "../monitor/production.js";
import type { TelegramBot, TelegramUpdate } from "../telegram/bot.js";

const activeConversationSyncs = new Set<string>();

interface Context {
  config: AppConfig;
  leads: LeadService;
  templates: TemplateService;
  system: SystemService;
  scheduler: Scheduler;
  notifier: Notifier;
  logger: Logger;
  auth?: AuthService;
  pending?: PendingActionService;
  worker?: BrowserWorker;
  hermes?: HermesClient;
  telegramBot?: TelegramBot | null;
}

export function webhookSecretValid(received: string | string[] | undefined, expected: string | undefined): boolean {
  if (!expected || typeof received !== "string") return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

class HttpError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

function json(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Content-Type must be application/json");
  let data = "";
  for await (const chunk of req) {
    data += chunk.toString();
    if (data.length > 65536) throw new HttpError(413, "Request body too large");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { throw new HttpError(400, "Invalid JSON body"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "JSON object required");
  return parsed as Record<string, unknown>;
}

function only(input: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new HttpError(400, `Unknown field: ${key}`);
}

function string(input: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
  if (value.length > 4000) throw new HttpError(400, `${key} is too long`);
  return value;
}

function number(input: Record<string, unknown>, key: string): number | null | undefined {
  const value = input[key];
  if (value === undefined || value === null) return value as null | undefined;
  if (typeof value !== "number") throw new HttpError(400, `${key} must be a number`);
  return value;
}

function localDay(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function overview(context: Context) {
  const all = context.leads.list();
  const pending = context.pending?.list() ?? [];
  const counts = Object.fromEntries(LEAD_STATUSES.map((status) => [status, all.filter((lead) => lead.status === status).length]));
  const today = localDay(new Date(), context.config.timezone);
  return {
    total: all.length, counts, outreach_today: all.filter((lead) => lead.sent_at && localDay(new Date(lead.sent_at), context.config.timezone) === today).length,
    replies: all.filter((lead) => lead.replied_at).length,
    daily_limit: context.config.outreachDailyLimit,
    outreach_mode: context.config.outreachMode,
    pending_approvals: pending.filter((action) => action.state === "PREPARED" && action.mode === "approval").length,
    pending_manual: pending.filter((action) => action.state === "PREPARED" && action.mode === "manual").length,
    needs_human: all.filter((lead) => lead.status === "HUMAN_TAKEOVER" || (lead.error_class && !["browser_offline", "temporary_navigation"].includes(lead.error_class))).length,
    failed_tasks: all.filter((lead) => lead.status === "FAILED" || lead.monitor_failures >= 3).length,
    recent_replies: all.filter((lead) => lead.replied_at).sort((a, b) => String(b.replied_at).localeCompare(String(a.replied_at))).slice(0, 5),
    recent_errors: all.filter((lead) => lead.error_message).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5),
    attention: all.filter((lead) => lead.status === "HUMAN_TAKEOVER" || lead.error_class).slice(0, 5),
    system: context.system.getSettings().paused ? "PAUSED" : "RUNNING",
    scheduler: context.scheduler.status(), timezone: context.config.timezone,
  };
}

export function createApiServer(context: Context): Server {
  const shared = { ...context, auth: context.auth ?? new AuthService(context.config) };
  return createServer((req, res) => { void handleApiRequest(req, res, shared); });
}

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse, context: Context): Promise<void> {
    const auth = context.auth ?? new AuthService(context.config);
    await guardedRoute(req, res, { ...context, auth }).catch((error: unknown) => {
      if (error instanceof HttpError) return json(res, error.code, { error: error.message });
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE constraint failed/.test(message)) return json(res, 409, { error: "Record already exists" });
      if (/^(Lead not found|Template not found)/.test(message)) return json(res, 404, { error: message });
      if (/^(Invalid transition|Cannot retry|Retry unavailable|Automation stopped|Template is assigned|Assign a template|Assigned template|Pending action|No approved pending|Lead is not available|Lead has already|Daily outreach limit|Send attempt limit|Automation is disabled|Lead changed since|Follow-up requires|Conversation sync|Only HUMAN_TAKEOVER)/.test(message)) return json(res, 409, { error: message });
      if (/^(Lead name|linkedin_url|Score|Name must|Template name|Template body|Unknown template|Malformed template|Invalid status)/.test(message)) {
        return json(res, 400, { error: message });
      }
      context.logger.error("API error", { path: req.url, error: message });
      json(res, 500, { error: "Internal server error" });
    });
}

async function guardedRoute(req: IncomingMessage, res: ServerResponse, context: Context & { auth: AuthService }): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = req.method ?? "GET";
  if (path === "/api/telegram/webhook") {
    if (context.config.telegramMode !== "webhook" || !context.telegramBot) throw new HttpError(404, "Not found");
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    if (!webhookSecretValid(req.headers["x-telegram-bot-api-secret-token"], context.config.telegramWebhookSecret)) {
      throw new HttpError(403, "Forbidden");
    }
    const update = await body(req);
    if (!Number.isSafeInteger(update.update_id) || typeof update.update_id !== "number") throw new HttpError(400, "Invalid Telegram update");
    await context.telegramBot.handleUpdate(update as unknown as TelegramUpdate);
    return json(res, 200, { ok: true });
  }
  if (path === "/api/health" && method === "GET") return json(res, 200, { ok: true });
  if (path === "/api/auth/login" && method === "POST") {
    const input = await body(req); only(input, ["username", "password"]);
    const result = context.auth.login(string(input, "username", true)!, string(input, "password", true)!, req.socket?.remoteAddress ?? "local");
    if (!result) throw new HttpError(401, "Invalid credentials");
    res.setHeader("Set-Cookie", result.cookie);
    return json(res, 200, { authenticated: true, csrf_token: result.csrf });
  }
  if (path === "/api/auth/session" && method === "GET") {
    if (!context.auth.enabled) return json(res, 200, { authenticated: true, auth_enabled: false, csrf_token: null });
    const session = context.auth.session(req);
    if (!session) throw new HttpError(401, "Authentication required");
    return json(res, 200, { authenticated: true, auth_enabled: true, csrf_token: session.csrf });
  }
  if (path === "/login.html" || path === "/login.js" || path === "/styles.css") return route(req, res, context);
  if (context.auth.enabled) {
    const session = context.auth.session(req);
    if (!session) {
      if (method === "GET" && (["/", "/index.html", "/leads", "/human-takeover"].includes(path) || /^\/leads\/[^/]+$/.test(path))) {
        res.writeHead(302, { Location: "/login.html", "Cache-Control": "no-store" }); res.end(); return;
      }
      throw new HttpError(401, "Authentication required");
    }
    if (!["GET", "HEAD"].includes(method) && !context.auth.csrfValid(req, session.csrf)) {
      throw new HttpError(403, "Invalid CSRF token");
    }
    if (path === "/api/auth/logout" && method === "POST") {
      res.setHeader("Set-Cookie", context.auth.logout(session.id));
      return json(res, 200, { logged_out: true });
    }
  }
  return route(req, res, context);
}

async function route(req: IncomingMessage, res: ServerResponse, context: Context): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path === "/api/overview" && method === "GET") return json(res, 200, overview(context));

  if (path === "/api/leads" && method === "GET") {
    const status = url.searchParams.get("status");
    let records = status ? context.leads.getByStatus(parseLeadStatus(status)) : context.leads.list();
    const search = url.searchParams.get("search")?.toLowerCase().trim();
    if (search) records = records.filter((lead) => [lead.name, lead.company, lead.job_title, lead.linkedin_url].some((value) => value?.toLowerCase().includes(search)));
    const sort = url.searchParams.get("sort") || "created_at";
    if (!["name", "company", "job_title", "status", "created_at", "sent_at", "replied_at", "score"].includes(sort)) throw new HttpError(400, "Invalid sort field");
    const direction = url.searchParams.get("direction") || "desc";
    if (!["asc", "desc"].includes(direction)) throw new HttpError(400, "Invalid sort direction");
    records.sort((a, b) => {
      const order = direction === "asc" ? 1 : -1;
      if (sort === "score") return ((a.score ?? -1) - (b.score ?? -1)) * order;
      return String(a[sort as keyof typeof a] ?? "").localeCompare(String(b[sort as keyof typeof b] ?? "")) * order;
    });
    const page = Number(url.searchParams.get("page") || 1);
    const pageSize = Number(url.searchParams.get("page_size") || 20);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new HttpError(400, "Invalid pagination");
    return json(res, 200, { items: records.slice((page - 1) * pageSize, page * pageSize), total: records.length, page, page_size: pageSize });
  }
  if (path === "/api/leads" && method === "POST") {
    const input = await body(req);
    only(input, ["name", "linkedin_url", "company", "job_title", "location", "score", "score_reason", "template_id"]);
    const lead = context.leads.create({ name: string(input, "name", true)!, linkedin_url: string(input, "linkedin_url", true)!,
      company: string(input, "company"), job_title: string(input, "job_title"), location: string(input, "location"),
      score: number(input, "score"), score_reason: string(input, "score_reason"), template_id: string(input, "template_id") });
    return json(res, 201, lead);
  }

  if (path === "/api/human-takeover" && method === "GET") {
    const handled = url.searchParams.get("handled") ?? "all";
    if (!["all", "handled", "unhandled"].includes(handled)) throw new HttpError(400, "Invalid handled filter");
    const from = url.searchParams.get("from");
    if (from && Number.isNaN(Date.parse(from))) throw new HttpError(400, "Invalid from date");
    const items = context.leads.getByStatus("HUMAN_TAKEOVER").filter((lead) => {
      if (handled === "handled" && !lead.human_handled_at) return false;
      if (handled === "unhandled" && lead.human_handled_at) return false;
      return !from || Boolean(lead.replied_at && Date.parse(lead.replied_at) >= Date.parse(from));
    }).map((lead) => {
      const conversation = context.leads.conversation(lead.id);
      const lastReply = conversation.filter((message) => message.direction === "incoming").at(-1) ?? null;
      return { ...lead, last_reply: lastReply, message_count: conversation.length };
    }).sort((a, b) => String(b.last_reply?.sent_at ?? b.replied_at).localeCompare(String(a.last_reply?.sent_at ?? a.replied_at)));
    return json(res, 200, items);
  }

  const leadMatch = /^\/api\/leads\/([^/]+)(?:\/(qualify|approve|reject|retry|human-takeover|follow-up|mark-handled|sync-conversation))?$/.exec(path);
  if (leadMatch) {
    const id = decodeURIComponent(leadMatch[1]!);
    const action = leadMatch[2];
    if (!action && method === "GET") {
      const lead = context.leads.getById(id);
      if (!lead) throw new HttpError(404, "Lead not found");
      return json(res, 200, { ...lead, pending_action: context.pending?.get(id) ?? null,
        conversation: context.leads.conversation(id), activity: context.leads.activity.list(id) });
    }
    if (!action && method === "PATCH") {
      const input = await body(req);
      only(input, ["name", "company", "job_title", "location", "score", "score_reason", "template_id"]);
      const patch: LeadPatch = {};
      for (const key of ["name", "company", "job_title", "location", "score_reason", "template_id"] as const) {
        if (key in input) patch[key] = input[key] === null ? null : string(input, key);
      }
      if ("score" in input) patch.score = number(input, "score");
      return json(res, 200, context.leads.patch(id, patch));
    }
    if (action && method === "POST") {
      if (action === "mark-handled") return json(res, 200, context.leads.markHumanHandled(id));
      if (action === "sync-conversation") {
        if (!context.worker) throw new HttpError(503, "Conversation sync unavailable");
        const settings = context.system.getSettings();
        if (!context.config.automationEnabled || settings.paused || !settings.monitor_enabled || !context.config.monitorEnabled) {
          throw new HttpError(409, "Automation is disabled or paused");
        }
        if (context.scheduler.status().running_jobs.includes("replies") || activeConversationSyncs.has(id)) {
          throw new HttpError(409, "Conversation sync is already running");
        }
        activeConversationSyncs.add(id);
        try {
          return json(res, 200, await syncLeadConversation(id, context.leads, context.worker,
            context.notifier, context.logger, context.config.publicUrl));
        } finally { activeConversationSyncs.delete(id); }
      }
      if (action === "follow-up") {
        if (!context.pending || !context.worker) throw new HttpError(503, "Follow-up unavailable");
        return json(res, 200, await prepareFollowUp(id, context.config, context.system, context.leads,
          context.templates, context.pending, context.worker, context.notifier, context.logger));
      }
      const lead = action === "qualify" ? context.leads.updateStatus(id, "QUALIFIED")
        : action === "approve" ? context.leads.approve(id)
        : action === "reject" ? context.pending?.get(id) ? context.pending.reject(id) : context.leads.reject(id)
        : action === "retry" ? context.leads.retry(id)
        : context.leads.humanTakeover(id);
      if (action === "approve") await notifySafely(context, `✅ Lead approved\n${lead.name}\n${lead.id}`);
      return json(res, 200, lead);
    }
  }

  if (path === "/api/pending" && method === "GET") {
    if (!context.pending) return json(res, 200, []);
    const state = url.searchParams.get("state");
    if (state && !["PREPARED", "SENDING", "SENT", "CANCELLED", "UNCERTAIN", "BLOCKED"].includes(state)) throw new HttpError(400, "Invalid pending state");
    return json(res, 200, context.pending.list(state as PendingState | undefined));
  }
  const pendingMatch = /^\/api\/pending\/([^/]+)\/(send|confirm-manual|correct-not-sent|reject)$/.exec(path);
  if (pendingMatch && method === "POST") {
    if (!context.pending) throw new HttpError(404, "Pending actions unavailable");
    const id = decodeURIComponent(pendingMatch[1]!);
    const action = pendingMatch[2];
    if (action === "send") {
      if (!context.worker) throw new HttpError(503, "Browser worker unavailable");
      return json(res, 200, await approveAndSend(id, context.config, context.system, context.leads,
        context.pending, context.worker, context.notifier, context.logger));
    }
    if (action === "confirm-manual") {
      const lead = context.pending.markSent(id, true);
      await notifySafely(context, `📤 Manual send confirmed\n${lead.name}\n${lead.id}`);
      return json(res, 200, lead);
    }
    if (action === "correct-not-sent") return json(res, 200, context.pending.correctManualNotSent(id));
    return json(res, 200, context.pending.reject(id));
  }

  if (path === "/api/templates" && method === "GET") return json(res, 200, context.templates.list());
  if (path === "/api/templates" && method === "POST") {
    const input = await body(req); only(input, ["name", "body"]);
    return json(res, 201, context.templates.create({ name: string(input, "name", true)!, body: string(input, "body", true)! }));
  }
  if (path === "/api/templates/preview" && method === "POST") {
    const input = await body(req); only(input, ["body", "values"]);
    const values = input.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new HttpError(400, "values must be an object");
    only(values as Record<string, unknown>, ["first_name", "name", "company", "job_title"]);
    for (const value of Object.values(values)) if (typeof value !== "string") throw new HttpError(400, "Preview values must be strings");
    return json(res, 200, { preview: renderTemplate(string(input, "body", true)!, values as Record<"first_name" | "name" | "company" | "job_title", string>) });
  }
  const templateMatch = /^\/api\/templates\/([^/]+)$/.exec(path);
  if (templateMatch) {
    const id = decodeURIComponent(templateMatch[1]!);
    if (method === "PATCH") {
      const input = await body(req); only(input, ["name", "body"]);
      return json(res, 200, context.templates.update(id, { name: string(input, "name"), body: string(input, "body") }));
    }
    if (method === "DELETE") { context.templates.delete(id); return json(res, 200, { deleted: true }); }
  }

  if (path === "/api/activity" && method === "GET") {
    const limit = Number(url.searchParams.get("limit") || 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "Invalid limit");
    return json(res, 200, context.leads.activity.list(url.searchParams.get("lead_id") || undefined, limit));
  }
  if (path === "/api/system/status" && method === "GET") return json(res, 200, {
    ...context.system.getSettings(), scheduler: context.scheduler.status(), daily_limit: context.config.outreachDailyLimit,
    sent_today: context.pending?.sentToday() ?? overview(context).outreach_today,
    outreach_mode: context.config.outreachMode,
    hermes_enabled: context.hermes?.enabled ?? false,
  });
  if (path === "/api/system/settings" && method === "PATCH") {
    const input = await body(req); only(input, ["outreach_enabled", "monitor_enabled"]);
    for (const key of ["outreach_enabled", "monitor_enabled"] as const) {
      if (key in input && typeof input[key] !== "boolean") throw new HttpError(400, `${key} must be boolean`);
    }
    for (const [key, job] of [["outreach_enabled", "outreach"], ["monitor_enabled", "monitor"]] as const) {
      if (key in input) context.system.setEnabled(job, input[key] as boolean);
    }
    return json(res, 200, context.system.getSettings());
  }
  if (path === "/api/system/pause" && method === "POST") {
    const settings = context.system.setPaused(true);
    await notifySafely(context, "⏸ System paused");
    return json(res, 200, settings);
  }
  if (path === "/api/system/resume" && method === "POST") {
    const settings = context.system.setPaused(false);
    await notifySafely(context, "▶️ System resumed");
    return json(res, 200, settings);
  }
  if (path === "/api/jobs/outreach/run" && method === "POST") return json(res, 200, await context.scheduler.run("outreach"));
  if (path === "/api/jobs/replies/run" && method === "POST") return json(res, 200, await context.scheduler.run("replies"));

  const appPage = path === "/leads" || path === "/human-takeover" || /^\/leads\/[^/]+$/.test(path);
  if (method === "GET" && (appPage || ["/", "/index.html", "/app.js", "/styles.css", "/login.html", "/login.js"].includes(path))) {
    const file = path === "/" || appPage ? "index.html" : path.slice(1);
    const content = await readFile(join(process.cwd(), "web", file));
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'" });
    res.end(content);
    return;
  }
  throw new HttpError(404, "Not found");
}

async function notifySafely(context: Context, message: string): Promise<void> {
  try { await context.notifier.notify(message); }
  catch (error) { context.logger.error("Notification failed", { error: error instanceof Error ? error.message : String(error) }); }
}
