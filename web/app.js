const state = { page: "overview", leadDetailId: null, search: "", status: "", sort: "created_at", direction: "desc", pageNumber: 1, showLeadForm: false, selectedTemplate: null, templates: [], takeoverRange: "all", takeoverHandled: "all" };
const app = document.querySelector("#app");
const drawerRoot = document.querySelector("#drawer-root");
const toastNode = document.querySelector("#toast");
let csrfToken = null;
function applyLocation() {
  const detail = /^\/leads\/([^/]+)$/.exec(window.location.pathname);
  state.leadDetailId = detail ? decodeURIComponent(detail[1]) : null;
  if (window.location.pathname === "/leads" || detail) state.page = "leads";
  if (window.location.pathname === "/human-takeover") state.page = "takeover";
}
async function navigate(path) {
  if (window.location.pathname !== path) history.pushState({}, "", path);
  applyLocation();
  await render();
}
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const date = (value) => value ? new Date(value).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }) : "—";
const badge = (value) => `<span class="badge ${escapeHtml(value)}">${escapeHtml(value.replaceAll("_", " "))}</span>`;
const iconPaths = {
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  reply: '<path d="m9 17-5-5 5-5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  qualified: '<path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2Z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  hand: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v4M12 17h.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M15 9 9 15M9 9l6 6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name]}</svg>`;
let toastTimer;

function toast(message, error = false) {
  toastNode.textContent = message;
  toastNode.className = `show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastNode.className = ""; }, 4000);
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(csrfToken && options.method && options.method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}) };
  const response = await fetch(`/api${path}`, { ...options, headers });
  if (response.status === 401) { window.location.replace("/login.html"); throw new Error("Session expired"); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
const post = (path, value) => api(path, { method: "POST", ...(value ? { body: JSON.stringify(value) } : {}) });
const patch = (path, value) => api(path, { method: "PATCH", body: JSON.stringify(value) });
const heading = (eyebrow, title, subtitle, action = "") => `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
const activityList = (items) => items.length ? items.map((item) => `<div class="activity-item"><i class="activity-dot"></i><div><strong>${escapeHtml(item.event.replaceAll("_", " "))}</strong><p>${escapeHtml(item.message)}</p><time>${date(item.created_at)}</time></div></div>`).join("") : `<div class="empty">Belum ada aktivitas.</div>`;

async function render() {
  document.querySelectorAll("[data-page]").forEach((button) => button.classList.toggle("active", !state.leadDetailId && button.dataset.page === state.page));
  document.querySelector("#current-page").textContent = state.leadDetailId ? "Lead detail" : ({ overview: "Overview", leads: "Leads", takeover: "Human Takeover", pending: "Pending", templates: "Templates", activity: "Activity", control: "Control center" })[state.page];
  try {
    const system = await api("/system/status");
    const pill = document.querySelector("#system-pill");
    pill.textContent = system.paused ? "⏸ PAUSED" : "● RUNNING";
    pill.className = `pill${system.paused ? " paused" : ""}`;
    document.querySelector("#sidebar-worker").textContent = `${system.scheduler.worker_type} worker · ${system.scheduler.worker_health.toLowerCase()}`;
    document.querySelector("#sidebar-automation").textContent = system.scheduler.automation_enabled ? "Automation enabled" : "Automation disabled";
    if (state.leadDetailId) await openLead(state.leadDetailId);
    else if (state.page === "overview") await overview();
    else if (state.page === "leads") await leadsPage();
    else if (state.page === "takeover") await humanTakeoverPage();
    else if (state.page === "pending") await pendingPage();
    else if (state.page === "templates") await templatesPage();
    else if (state.page === "activity") await activityPage();
    else await controlPage();
  } catch (error) {
    app.innerHTML = `<div class="panel"><div class="empty">${escapeHtml(error.message)}<br><br><button class="button secondary" data-action="refresh">Coba lagi</button></div></div>`;
  }
}

async function overview() {
  const [data, activities, pending] = await Promise.all([api("/overview"), api("/activity?limit=6"), api("/pending")]);
  const metrics = [
    ["Total leads", data.total, "users", "All contacts"], ["Approved", data.counts.APPROVED, "check", "Ready for review"],
    ["Outreach today", `${data.outreach_today}/${data.daily_limit}`, "send", data.timezone], ["Replies", data.replies, "reply", "All time"],
    ["New", data.counts.NEW, "plus", "Waiting for review"], ["Qualified", data.counts.QUALIFIED, "qualified", "Awaiting approval"],
    ["Sent", data.counts.SENT, "mail", "Awaiting reply"], ["Human takeover", data.counts.HUMAN_TAKEOVER, "hand", "Manual follow-up"],
    ["Pending approval", data.pending_approvals, "clock", "Explicit send approval"], ["Needs human", data.needs_human, "alert", "Review required"],
    ["Failed tasks", data.failed_tasks, "error", "Check recent errors"], ["Manual pending", data.pending_manual, "file", "Send and confirm"],
  ];
  const statusRows = ["NEW", "QUALIFIED", "APPROVED", "SENT", "REPLIED", "HUMAN_TAKEOVER", "FAILED"];
  const pendingReview = pending.filter((item) => item.state === "PREPARED" && item.mode === "approval").slice(0, 5);
  const attentionRows = (items, detail) => items.length
    ? items.map((item) => `<div class="activity-item"><i class="activity-dot"></i><div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(detail(item))}</p><button class="button secondary" data-open-lead="${escapeHtml(item.id)}">Open lead</button></div></div>`).join("")
    : `<div class="empty">Nothing to review.</div>`;
  const pipelinePanel = `<section class="panel"><div class="panel-head"><h2>Lead pipeline</h2><span class="subtle">By current status</span></div><div class="panel-body status-list">${statusRows.map((status) => `<div class="status-row"><span>${status.replaceAll("_", " ")}</span><progress class="bar" value="${data.counts[status]}" max="${Math.max(1, data.total)}"></progress><strong>${data.counts[status]}</strong></div>`).join("")}</div></section>`;
  const activityPanel = `<section class="panel"><div class="panel-head"><h2>Recent activity</h2><button class="button secondary" data-page="activity">View all</button></div><div class="panel-body">${activityList(activities)}</div></section>`;
  const systemPanel = `<section class="panel"><div class="panel-head"><h2>System overview</h2><span class="pill${data.system === "PAUSED" ? " paused" : ""}">${data.system}</span></div><div class="panel-body"><div class="kv"><span>Scheduler</span><strong>${data.scheduler.health}</strong></div><div class="kv"><span>Browser worker</span><strong>${escapeHtml(data.scheduler.worker_type)} · ${escapeHtml(data.scheduler.worker_health)}</strong></div><div class="kv"><span>Last outreach</span><strong>${date(data.scheduler.last_runs.find((run) => run.name === "outreach")?.last_finished_at)}</strong></div><div class="kv"><span>Last reply check</span><strong>${date(data.scheduler.last_runs.find((run) => run.name === "replies")?.last_finished_at)}</strong></div><div class="kv"><span>Next outreach</span><strong>${date(data.scheduler.next_run.outreach)}</strong></div><div class="kv"><span>Next reply check</span><strong>${date(data.scheduler.next_run.replies)}</strong></div></div></section>`;
  const quickPanel = `<section class="panel"><div class="panel-head"><h2>Quick actions</h2></div><div class="panel-body"><p class="muted quick-action-description">Worker ${escapeHtml(data.scheduler.worker_type)} · outreach mode ${escapeHtml(data.outreach_mode)} · automation ${data.scheduler.automation_enabled ? "enabled" : "disabled"}.</p><div class="button-row"><button class="button" data-action="run-outreach">Run outreach</button><button class="button secondary" data-action="run-replies">Run reply check</button></div></div></section>`;
  const pendingPanel = `<section class="panel"><div class="panel-head"><h2>Pending Approval</h2><button class="button secondary" data-page="pending">View all</button></div><div class="panel-body">${pendingReview.length ? pendingReview.map((item) => `<div class="activity-item"><i class="activity-dot"></i><div><strong>${escapeHtml(item.profile_name)}</strong><p>${escapeHtml(item.mode)} · ${escapeHtml(item.message.slice(0, 90))}</p><button class="button secondary" data-open-lead="${escapeHtml(item.lead_id)}">Review message</button></div></div>`).join("") : `<div class="empty">No pending approvals.</div>`}</div></section>`;
  const humanPanel = `<section class="panel"><div class="panel-head"><h2>Needs Human Attention</h2></div><div class="panel-body">${attentionRows(data.attention, (lead) => lead.error_message || lead.status)}</div></section>`;
  const repliesPanel = `<section class="panel"><div class="panel-head"><h2>Recent Replies</h2></div><div class="panel-body">${attentionRows(data.recent_replies, (lead) => `Replied ${date(lead.replied_at)} · ${lead.status}`)}</div></section>`;
  const errorsPanel = `<section class="panel"><div class="panel-head"><h2>Recent Errors</h2></div><div class="panel-body">${attentionRows(data.recent_errors, (lead) => lead.error_message)}</div></section>`;
  app.innerHTML = heading("Dashboard", "Good to see you.", "Ringkasan pipeline dan aktivitas lokal Anda.", `<button class="button" data-page="leads">View leads →</button>`)
    + `<section class="metrics">${metrics.map(([label, value, iconName, foot]) => `<div class="metric"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon(iconName)}</span></div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></div>`).join("")}</section>`
    + `<div class="dashboard-columns"><div class="dashboard-column">${pipelinePanel}${systemPanel}${pendingPanel}${repliesPanel}</div><div class="dashboard-column">${activityPanel}${quickPanel}${humanPanel}${errorsPanel}</div></div>`;
}

async function pendingPage() {
  const [items, leads] = await Promise.all([api("/pending"), api("/leads?page_size=100")]);
  const names = new Map(leads.items.map((lead) => [lead.id, lead.name]));
  const active = items.filter((item) => !["SENT", "CANCELLED"].includes(item.state));
  app.innerHTML = heading("Review queue", "Pending actions", "Setiap pengiriman membutuhkan langkah manusia yang eksplisit.")
    + `<section class="panel"><div class="panel-head"><h2>Pending outreach</h2><span class="subtle">${active.length} need review</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Lead</th><th>Mode</th><th>State</th><th>Message preview</th><th>Prepared</th></tr></thead><tbody>${active.map((item) => `<tr data-open-lead="${escapeHtml(item.lead_id)}"><td><span class="cell-main">${escapeHtml(names.get(item.lead_id) || item.lead_id)}</span><span class="cell-sub">${escapeHtml(item.lead_id.slice(0, 8))}</span></td><td>${escapeHtml(item.mode)}</td><td>${badge(item.state)}</td><td>${escapeHtml(item.message.slice(0, 80))}${item.message.length > 80 ? "…" : ""}</td><td>${date(item.created_at)}</td></tr>`).join("")}</tbody></table>${active.length ? "" : `<div class="empty">No pending actions.</div>`}</div></section>`;
}

async function leadsPage() {
  const params = new URLSearchParams({ page: String(state.pageNumber), page_size: "15", sort: state.sort, direction: state.direction });
  if (state.search) params.set("search", state.search);
  if (state.status) params.set("status", state.status);
  const [data, templates] = await Promise.all([api(`/leads?${params}`), api("/templates")]);
  state.templates = templates;
  const statusOptions = ["NEW", "QUALIFIED", "APPROVED", "SENT", "REPLIED", "HUMAN_TAKEOVER", "SKIPPED", "FAILED"];
  app.innerHTML = heading("Pipeline", "Leads", "Review, approve, dan pantau setiap prospect.", `<button class="button" data-action="toggle-lead-form">+ Add lead</button>`)
    + (state.showLeadForm ? `<section class="panel lead-form-panel"><div class="panel-head"><h2>New lead</h2></div><div class="panel-body"><form id="add-lead" class="form-grid"><label class="field">Name <input class="input" name="name" required maxlength="200"></label><label class="field">LinkedIn URL <input class="input" name="linkedin_url" type="url" required placeholder="https://www.linkedin.com/in/..."></label><label class="field">Company <input class="input" name="company"></label><label class="field">Job title <input class="input" name="job_title"></label><label class="field">Location <input class="input" name="location"></label><label class="field">Template <select name="template_id"><option value="">Choose later</option>${templates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join("")}</select></label><div class="field full"><div class="form-actions"><button class="button" type="submit">Save lead</button></div></div></form></div></section>` : "")
    + `<section class="panel"><div class="panel-head"><h2>All leads</h2><span class="subtle">${data.total} total</span></div><div class="panel-body toolbar-panel-body"><div class="toolbar"><input class="input search" id="lead-search" placeholder="Search name, company, title, URL…" value="${escapeHtml(state.search)}"><select id="lead-status-filter"><option value="">All statuses</option>${statusOptions.map((value) => `<option value="${value}" ${state.status === value ? "selected" : ""}>${value.replaceAll("_", " ")}</option>`).join("")}</select><select id="lead-sort"><option value="created_at" ${state.sort === "created_at" ? "selected" : ""}>Created</option><option value="name" ${state.sort === "name" ? "selected" : ""}>Name</option><option value="company" ${state.sort === "company" ? "selected" : ""}>Company</option><option value="score" ${state.sort === "score" ? "selected" : ""}>Score</option><option value="sent_at" ${state.sort === "sent_at" ? "selected" : ""}>Sent date</option></select><button class="button secondary" data-action="sort-direction">${state.direction === "desc" ? "↓" : "↑"}</button></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Company / title</th><th>LinkedIn URL</th><th>Status</th><th>Template</th><th>Score</th><th>Created</th><th>Sent</th><th>Replied</th></tr></thead><tbody>${data.items.map((lead) => `<tr data-open-lead="${escapeHtml(lead.id)}"><td><span class="cell-main">${escapeHtml(lead.name)}</span><span class="cell-sub">${escapeHtml(lead.location || "—")}</span></td><td>${escapeHtml(lead.company || "—")}<span class="cell-sub">${escapeHtml(lead.job_title || "—")}</span></td><td><a href="${escapeHtml(lead.linkedin_url)}" target="_blank" rel="noopener noreferrer" data-stop-row>Open profile ↗</a></td><td>${badge(lead.status)}</td><td>${escapeHtml(templates.find((t) => t.id === lead.template_id)?.name || "—")}</td><td>${lead.score ?? "—"}</td><td>${date(lead.created_at)}</td><td>${date(lead.sent_at)}</td><td>${date(lead.replied_at)}</td></tr>`).join("")}</tbody></table>${data.items.length ? "" : `<div class="empty">No leads found. Add a lead or adjust filters.</div>`}</div><div class="pagination"><span>Page ${data.page} of ${Math.max(1, Math.ceil(data.total / 15))}</span><div><button data-action="prev-page" ${data.page <= 1 ? "disabled" : ""}>Previous</button><button data-action="next-page" ${data.page * 15 >= data.total ? "disabled" : ""}>Next</button></div></div></section>`;
}

async function humanTakeoverPage() {
  const params = new URLSearchParams({ handled: state.takeoverHandled });
  if (state.takeoverRange !== "all") {
    const from = new Date();
    if (state.takeoverRange === "today") from.setHours(0, 0, 0, 0);
    else from.setDate(from.getDate() - Number(state.takeoverRange));
    params.set("from", from.toISOString());
  }
  const items = await api(`/human-takeover?${params}`);
  const unhandled = items.filter((lead) => !lead.human_handled_at).length;
  app.innerHTML = heading("Inbox", "Human Takeover", "Balasan LinkedIn yang perlu ditangani secara langsung.")
    + `<section class="takeover-summary"><div><span>Ditampilkan</span><strong>${items.length}</strong></div><div><span>Belum ditangani</span><strong>${unhandled}</strong></div></section>`
    + `<section class="panel"><div class="panel-head takeover-toolbar"><div><h2>Reply inbox</h2><span class="subtle">Urut dari balasan terbaru</span></div><div class="toolbar"><select id="takeover-range"><option value="all" ${state.takeoverRange === "all" ? "selected" : ""}>Semua waktu</option><option value="today" ${state.takeoverRange === "today" ? "selected" : ""}>Hari ini</option><option value="7" ${state.takeoverRange === "7" ? "selected" : ""}>7 hari terakhir</option><option value="30" ${state.takeoverRange === "30" ? "selected" : ""}>30 hari terakhir</option></select><select id="takeover-handled"><option value="all" ${state.takeoverHandled === "all" ? "selected" : ""}>Semua status</option><option value="unhandled" ${state.takeoverHandled === "unhandled" ? "selected" : ""}>Belum ditangani</option><option value="handled" ${state.takeoverHandled === "handled" ? "selected" : ""}>Sudah ditangani</option></select></div></div><div class="panel-body takeover-list">${items.length ? items.map((lead) => `<article class="takeover-item ${lead.human_handled_at ? "handled" : "unhandled"}"><div class="takeover-main"><div class="takeover-title"><span class="unread-dot" aria-hidden="true"></span><div><h3>${escapeHtml(lead.name)}</h3><p>${escapeHtml([lead.company, lead.job_title].filter(Boolean).join(" · ") || "—")}</p></div></div><time>${date(lead.last_reply?.sent_at || lead.replied_at)}</time></div><div class="reply-preview">${escapeHtml(lead.last_reply?.body || "Isi balasan belum tersinkron.")}</div><div class="takeover-meta"><span>${lead.message_count} pesan</span><span>${lead.human_handled_at ? `Ditangani ${date(lead.human_handled_at)}` : "Belum ditangani"}</span></div><div class="button-row"><button class="button secondary" data-open-lead="${escapeHtml(lead.id)}">Lihat detail</button><a class="button secondary" href="${escapeHtml(lead.conversation_url || "https://www.linkedin.com/messaging/")}" target="_blank" rel="noopener noreferrer">Open LinkedIn conversation ↗</a><button class="button secondary" data-takeover-action="sync" data-lead-id="${escapeHtml(lead.id)}">Sync conversation now</button>${lead.human_handled_at ? "" : `<button class="button" data-takeover-action="handled" data-lead-id="${escapeHtml(lead.id)}">Mark as handled</button>`}</div></article>`).join("") : `<div class="empty">Tidak ada balasan untuk filter ini.</div>`}</div></section>`;
}

async function openLead(id) {
  state.leadDetailId = id;
  drawerRoot.innerHTML = "";
  document.querySelectorAll("[data-page]").forEach((button) => button.classList.remove("active"));
  document.querySelector("#current-page").textContent = "Lead detail";
  const lead = await api(`/leads/${encodeURIComponent(id)}`);
  const templates = state.templates.length ? state.templates : await api("/templates");
  const actions = [];
  if (lead.status === "NEW") actions.push(["qualify", "Qualify"]);
  if (lead.status === "QUALIFIED") actions.push(["approve", "Approve"]);
  if (["NEW", "QUALIFIED", "APPROVED"].includes(lead.status) && !["SENDING", "UNCERTAIN"].includes(lead.pending_action?.state)) actions.push(["reject", "Reject / skip"]);
  if (lead.status === "FAILED" && lead.outreach_attempts < 3 && !lead.sent_at) actions.push(["retry", "Review & retry"]);
  if (lead.status === "SENT" && lead.monitor_failures >= 3) actions.push(["retry", "Retry reply check"]);
  if (lead.status === "SENT" && lead.pending_action?.state === "SENT") actions.push(["follow-up", "Test again / follow-up"]);
  if (lead.status === "REPLIED") actions.push(["human-takeover", "Human takeover"]);
  const pending = lead.pending_action;
  const pendingButtons = pending?.state === "PREPARED"
    ? pending.mode === "approval"
      ? `<button class="button" data-pending-action="send" data-lead-id="${escapeHtml(id)}">Approve & send now</button><button class="button danger" data-pending-action="reject" data-lead-id="${escapeHtml(id)}">Reject pending</button>`
      : `<button class="button secondary" data-pending-action="copy" data-lead-id="${escapeHtml(id)}">Copy message</button><button class="button" data-pending-action="confirm-manual" data-lead-id="${escapeHtml(id)}">Confirm: already sent in LinkedIn</button><button class="button danger" data-pending-action="reject" data-lead-id="${escapeHtml(id)}">Reject pending</button>`
    : ["UNCERTAIN", "BLOCKED"].includes(pending?.state)
      ? `<button class="button" data-pending-action="confirm-manual" data-lead-id="${escapeHtml(id)}">Confirm after manual check</button>`
      : pending?.state === "SENT" && pending.mode === "manual"
        ? `<button class="button danger" data-pending-action="correct-not-sent" data-lead-id="${escapeHtml(id)}">Correct: message was not sent</button>`
      : "";
  const pendingHtml = pending ? `<section class="pending-review"><h3>Pending outreach · ${escapeHtml(pending.state)}</h3><p class="muted">Mode: ${escapeHtml(pending.mode)} · Prepared: ${date(pending.created_at)}</p><div class="preview">${escapeHtml(pending.message)}</div>${pending.last_error ? `<p class="error-note">${escapeHtml(pending.last_error)}</p>` : ""}<div class="button-row pending-actions">${pendingButtons}</div></section><hr class="divider">` : "";
  const conversation = lead.conversation || [];
  const conversationHtml = `<section class="conversation-panel"><div class="conversation-head"><div><p class="eyebrow">Conversation</p><h3>Chat dengan ${escapeHtml(lead.name)}</h3></div><span class="subtle">${conversation.length} pesan tersimpan</span></div>${conversation.length
    ? `<div class="chat-list">${conversation.map((message) => `<article class="chat-bubble ${message.direction}"><div class="chat-label"><strong>${message.direction === "outgoing" ? "Anda mengirim" : `${escapeHtml(lead.name)} membalas`}</strong><span>${date(message.sent_at)}</span></div><p>${escapeHtml(message.body)}</p><small>${message.direction === "incoming" ? "Dibaca dari LinkedIn oleh reply monitor" : message.source === "playwright" ? "Terkirim dan diverifikasi Playwright" : message.source === "manual" ? "Dikonfirmasi manual" : "Terkirim, diverifikasi dari percakapan LinkedIn"}</small></article>`).join("")}</div>`
    : `<div class="empty">Belum ada isi chat yang tersimpan. Jalankan reply check untuk menyinkronkan percakapan.</div>`}</section><hr class="divider">`;
  app.innerHTML = `<div class="lead-detail-page"><div class="lead-detail-nav"><button class="button secondary" data-action="back-to-leads">← Kembali ke Leads</button></div><section class="panel lead-detail-card"><div class="drawer-head"><div><p class="eyebrow">Lead detail</p><h2>${escapeHtml(lead.name)}</h2><div class="lead-status">${badge(lead.status)}</div></div></div><div class="button-row">${actions.map(([action, label]) => `<button class="button ${action === "reject" ? "danger" : action === "qualify" ? "secondary" : ""}" data-lead-action="${action}" data-lead-id="${escapeHtml(id)}">${label}</button>`).join("")}</div><div class="detail-meta"><div><small>Lead ID</small><strong>${escapeHtml(lead.id)}</strong></div><div><small>Company</small><strong>${escapeHtml(lead.company || "—")}</strong></div><div><small>Job title</small><strong>${escapeHtml(lead.job_title || "—")}</strong></div><div><small>Location</small><strong>${escapeHtml(lead.location || "—")}</strong></div><div><small>Score</small><strong>${lead.score ?? "—"}</strong></div><div><small>Template</small><strong>${escapeHtml(templates.find((t) => t.id === lead.template_id)?.name || "—")}</strong></div><div><small>Created</small><strong>${date(lead.created_at)}</strong></div><div><small>Updated</small><strong>${date(lead.updated_at)}</strong></div><div><small>Approved</small><strong>${date(lead.approved_at)}</strong></div><div><small>Sent</small><strong>${date(lead.sent_at)}</strong></div><div><small>Replied</small><strong>${date(lead.replied_at)}</strong></div><div><small>Last checked</small><strong>${date(lead.last_checked_at)}</strong></div><div><small>Last error</small><strong>${escapeHtml(lead.error_message || "—")}</strong></div><div><small>Score reason</small><strong>${escapeHtml(lead.score_reason || "—")}</strong></div><div><small>Outreach attempts</small><strong>${lead.outreach_attempts}</strong></div><div><small>Reply check failures</small><strong>${lead.monitor_failures}</strong></div><div><small>Outreach claimed</small><strong>${date(lead.outreach_claimed_at)}</strong></div></div><p class="profile-link"><a href="${escapeHtml(lead.linkedin_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(lead.linkedin_url)} ↗</a></p><hr class="divider">${conversationHtml}${pendingHtml}<h3>Edit lead</h3><form id="edit-lead" data-id="${escapeHtml(id)}" class="form-grid"><label class="field">Name<input class="input" name="name" required value="${escapeHtml(lead.name)}"></label><label class="field">Company<input class="input" name="company" value="${escapeHtml(lead.company || "")}"></label><label class="field">Job title<input class="input" name="job_title" value="${escapeHtml(lead.job_title || "")}"></label><label class="field">Location<input class="input" name="location" value="${escapeHtml(lead.location || "")}"></label><label class="field">Score<input class="input" name="score" type="number" min="0" max="100" value="${lead.score ?? ""}"></label><label class="field">Template<select name="template_id"><option value="">Unassigned</option>${templates.map((t) => `<option value="${escapeHtml(t.id)}" ${t.id === lead.template_id ? "selected" : ""}>${escapeHtml(t.name)}</option>`).join("")}</select></label><label class="field full">Score reason<input class="input" name="score_reason" value="${escapeHtml(lead.score_reason || "")}"></label><div class="field full"><div class="form-actions"><button class="button" type="submit">Save changes</button></div></div></form><hr class="divider"><h3>Activity timeline</h3>${activityList(lead.activity)}</section></div>`;
}

async function templatesPage() {
  state.templates = await api("/templates");
  const selected = state.templates.find((t) => t.id === state.selectedTemplate);
  app.innerHTML = heading("Messaging", "Templates", "Tulis pesan deterministik dengan variabel sederhana.", `<button class="button" data-action="new-template">+ New template</button>`)
    + `<div class="template-layout"><section class="panel"><div class="panel-head"><h2>Saved templates</h2><span class="subtle">${state.templates.length}</span></div><div class="panel-body template-list">${state.templates.length ? state.templates.map((t) => `<button class="template-item ${t.id === state.selectedTemplate ? "active" : ""}" data-template="${escapeHtml(t.id)}"><strong>${escapeHtml(t.name)}</strong><small>${escapeHtml(t.body)}</small></button>`).join("") : `<div class="empty">Belum ada template.</div>`}</div></section><section class="panel"><div class="panel-head"><h2>${selected ? "Edit template" : "New template"}</h2>${selected ? `<button class="button danger" data-action="delete-template">Delete</button>` : ""}</div><div class="panel-body"><form id="template-form"><div class="form-grid"><label class="field full">Template name<input class="input" name="name" required maxlength="100" value="${escapeHtml(selected?.name || "")}" placeholder="Intro partnership"></label><label class="field full">Message body<textarea name="body" required maxlength="4000" placeholder="Hi {{first_name}}, ...">${escapeHtml(selected?.body || "")}</textarea></label></div><p class="subtle">Variables: {{first_name}}, {{name}}, {{company}}, {{job_title}}</p><div class="form-actions"><button type="button" class="button secondary" data-action="preview-template">Preview</button><button class="button" type="submit">${selected ? "Save changes" : "Create template"}</button></div></form><hr class="divider"><h3>Preview</h3><div class="form-grid"><label class="field">Name<input class="input preview-value" data-key="name" value="Jane Doe"></label><label class="field">Company<input class="input preview-value" data-key="company" value="Acme"></label><label class="field">Job title<input class="input preview-value" data-key="job_title" value="Product Lead"></label></div><div id="template-preview" class="preview template-preview">Click Preview to see the rendered message.</div></div></section></div>`;
}

async function activityPage() {
  const items = await api("/activity?limit=200");
  app.innerHTML = heading("Audit trail", "Activity", "Semua perubahan penting pada leads dan sistem.")
    + `<section class="panel"><div class="panel-head"><h2>Recent events</h2><span class="subtle">Latest ${items.length}</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Time</th><th>Event</th><th>Detail</th><th>Lead</th></tr></thead><tbody>${items.map((item) => `<tr ${item.lead_id ? `data-open-lead="${escapeHtml(item.lead_id)}"` : ""}><td>${date(item.created_at)}</td><td><span class="cell-main">${escapeHtml(item.event.replaceAll("_", " "))}</span></td><td>${escapeHtml(item.message)}</td><td>${item.lead_id ? escapeHtml(item.lead_id.slice(0, 8)) : "System"}</td></tr>`).join("")}</tbody></table>${items.length ? "" : `<div class="empty">Belum ada aktivitas.</div>`}</div></section>`;
}

async function controlPage() {
  const data = await api("/system/status");
  const runs = Object.fromEntries(data.scheduler.last_runs.map((run) => [run.name, run]));
  app.innerHTML = heading("Operations", "Control center", "Kelola scheduler dan jalankan workflow sesuai worker aktif.", `<span class="pill${data.paused ? " paused" : ""}">${data.paused ? "PAUSED" : "RUNNING"}</span>`)
    + `<div class="control-grid"><section class="panel control-card"><h2>System control</h2><p>Saat paused, outreach dan reply monitor tidak berjalan. Dashboard tetap tersedia.</p><div class="button-row"><button class="button danger" data-action="pause" ${data.paused ? "disabled" : ""}>⏸ Pause system</button><button class="button" data-action="resume" ${!data.paused ? "disabled" : ""}>▶ Resume system</button></div><hr class="divider"><div class="switch-row"><span>Outreach enabled</span><input type="checkbox" data-setting="outreach_enabled" ${data.outreach_enabled ? "checked" : ""}></div><div class="switch-row"><span>Reply monitor enabled</span><input type="checkbox" data-setting="monitor_enabled" ${data.monitor_enabled ? "checked" : ""}></div></section><section class="panel control-card"><h2>Run jobs</h2><p>Job manual mengikuti status pause dan pengaturan enabled. Setiap job punya lock agar tidak overlap.</p><div class="button-row"><button class="button" data-action="run-outreach">Run outreach</button><button class="button secondary" data-action="run-replies">Run reply check</button></div><hr class="divider"><div class="kv"><span>Scheduler health</span><strong>${data.scheduler.health}</strong></div><div class="kv"><span>Worker health</span><strong>${escapeHtml(data.scheduler.worker_type)} · ${escapeHtml(data.scheduler.worker_health)}</strong></div><div class="kv"><span>Automation</span><strong>${data.scheduler.automation_enabled ? "ENABLED" : "KILL SWITCH OFF"}</strong></div><div class="kv"><span>Outreach mode</span><strong>${escapeHtml(data.outreach_mode)}</strong></div><div class="kv"><span>Daily usage</span><strong>${data.sent_today}/${data.daily_limit}</strong></div><div class="kv"><span>Running jobs</span><strong>${data.scheduler.running_jobs.join(", ") || "None"}</strong></div></section><section class="panel control-card"><h2>Outreach schedule</h2><div class="kv"><span>Interval</span><strong>${data.scheduler.intervals_seconds.outreach}s</strong></div><div class="kv"><span>Next run</span><strong>${date(data.scheduler.next_run.outreach)}</strong></div><div class="kv"><span>Last run</span><strong>${date(runs.outreach?.last_finished_at)}</strong></div><div class="kv"><span>Result</span><strong>${escapeHtml(runs.outreach?.last_status || "—")}</strong></div></section><section class="panel control-card"><h2>Reply monitor schedule</h2><div class="kv"><span>Interval</span><strong>${data.scheduler.intervals_seconds.replies}s</strong></div><div class="kv"><span>Next run</span><strong>${date(data.scheduler.next_run.replies)}</strong></div><div class="kv"><span>Last run</span><strong>${date(runs.replies?.last_finished_at)}</strong></div><div class="kv"><span>Result</span><strong>${escapeHtml(runs.replies?.last_status || "—")}</strong></div></section></div>`;
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button, tr[data-open-lead]");
  if (!button) return;
  if (event.target.closest("[data-stop-row]")) return;
  try {
    if (button.dataset.page) {
      state.page = button.dataset.page; state.leadDetailId = null; state.showLeadForm = false; drawerRoot.innerHTML = "";
      await navigate(button.dataset.page === "leads" ? "/leads" : button.dataset.page === "takeover" ? "/human-takeover" : "/"); return;
    }
    if (button.dataset.openLead) { await navigate(`/leads/${encodeURIComponent(button.dataset.openLead)}`); return; }
    if (button.dataset.takeoverAction) {
      const id = button.dataset.leadId;
      button.disabled = true;
      button.textContent = button.dataset.takeoverAction === "sync" ? "Syncing…" : "Saving…";
      const result = await post(`/leads/${encodeURIComponent(id)}/${button.dataset.takeoverAction === "sync" ? "sync-conversation" : "mark-handled"}`);
      toast(button.dataset.takeoverAction === "sync" ? `Sync selesai: ${result.newMessages} pesan baru` : "Lead ditandai sudah ditangani");
      await humanTakeoverPage(); return;
    }
    if (button.dataset.template) { state.selectedTemplate = button.dataset.template; await templatesPage(); return; }
    if (button.dataset.leadAction) {
      if (button.dataset.leadAction === "follow-up" && !confirm("Prepare another message for this existing LinkedIn conversation? You will review it before sending.")) return;
      await post(`/leads/${encodeURIComponent(button.dataset.leadId)}/${button.dataset.leadAction}`);
      toast(button.dataset.leadAction === "follow-up" ? "Follow-up ready for approval" : "Lead updated"); await openLead(button.dataset.leadId); return;
    }
    if (button.dataset.pendingAction) {
      const id = button.dataset.leadId;
      const action = button.dataset.pendingAction;
      if (action === "copy") {
        const lead = await api(`/leads/${encodeURIComponent(id)}`);
        await navigator.clipboard.writeText(lead.pending_action.message);
        toast("Message copied"); return;
      }
      const prompt = action === "send" ? "Send this approved message through LinkedIn now?"
        : action === "confirm-manual" ? "This button does not send anything. Confirm only if the message is already visible in the LinkedIn conversation. Continue?"
        : action === "correct-not-sent" ? "Confirm that the message was not sent in LinkedIn. The lead will return to APPROVED for a new outreach attempt."
        : "Reject this pending outreach?";
      if (!confirm(prompt)) return;
      const result = await post(`/pending/${encodeURIComponent(id)}/${action}`);
      toast(action === "send" ? `Send result: ${result.status}` : "Pending action updated");
      await openLead(id); return;
    }
    switch (button.dataset.action) {
      case "refresh": await render(); break;
      case "back-to-leads": await navigate("/leads"); break;
      case "toggle-lead-form": state.showLeadForm = !state.showLeadForm; await leadsPage(); break;
      case "close-drawer": if (event.target === button || button.tagName === "BUTTON") drawerRoot.innerHTML = ""; break;
      case "prev-page": state.pageNumber--; await leadsPage(); break;
      case "next-page": state.pageNumber++; await leadsPage(); break;
      case "sort-direction": state.direction = state.direction === "asc" ? "desc" : "asc"; await leadsPage(); break;
      case "new-template": state.selectedTemplate = null; await templatesPage(); break;
      case "delete-template": if (state.selectedTemplate && confirm("Delete this template?")) { await api(`/templates/${encodeURIComponent(state.selectedTemplate)}`, { method: "DELETE" }); state.selectedTemplate = null; toast("Template deleted"); await templatesPage(); } break;
      case "preview-template": {
        const form = document.querySelector("#template-form");
        const name = document.querySelector('[data-key="name"]').value;
        const values = { name, first_name: name.trim().split(/\s+/)[0] || "", company: document.querySelector('[data-key="company"]').value, job_title: document.querySelector('[data-key="job_title"]').value };
        const result = await post("/templates/preview", { body: form.elements.namedItem("body").value, values });
        document.querySelector("#template-preview").textContent = result.preview;
        break;
      }
      case "pause": await post("/system/pause"); toast("System paused"); await render(); break;
      case "resume": await post("/system/resume"); toast("System resumed"); await render(); break;
      case "run-outreach": { const result = await post("/jobs/outreach/run"); toast(result.status === "skipped" ? result.reason : `Outreach: ${result.result.sent ?? result.result.prepared ?? 0} sent/prepared, ${result.result.failed} failed`); await render(); break; }
      case "run-replies": { const result = await post("/jobs/replies/run"); toast(result.status === "skipped" ? result.reason : `Replies: ${result.result.replied}, takeover: ${result.result.handoffs}`); await render(); break; }
    }
  } catch (error) { toast(error.message, true); }
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!["add-lead", "edit-lead", "template-form"].includes(form.id)) return;
  event.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(form).entries());
    if (form.id === "add-lead") { await post("/leads", values); state.showLeadForm = false; toast("Lead created"); await leadsPage(); }
    if (form.id === "edit-lead") {
      values.score = values.score === "" ? null : Number(values.score);
      for (const key of ["company", "job_title", "location", "score_reason", "template_id"]) if (values[key] === "") values[key] = null;
      await patch(`/leads/${encodeURIComponent(form.dataset.id)}`, values); toast("Lead saved"); await openLead(form.dataset.id);
    }
    if (form.id === "template-form") {
      const template = state.selectedTemplate ? await patch(`/templates/${encodeURIComponent(state.selectedTemplate)}`, values) : await post("/templates", values);
      state.selectedTemplate = template.id; toast("Template saved"); await templatesPage();
    }
  } catch (error) { toast(error.message, true); }
});

let searchTimer;
document.addEventListener("input", (event) => {
  if (event.target.id !== "lead-search") return;
  state.search = event.target.value; state.pageNumber = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => { const position = state.search.length; await leadsPage(); const input = document.querySelector("#lead-search"); input.focus(); input.setSelectionRange(position, position); }, 300);
});
document.addEventListener("change", async (event) => {
  try {
    if (event.target.id === "lead-status-filter") { state.status = event.target.value; state.pageNumber = 1; await leadsPage(); }
    if (event.target.id === "lead-sort") { state.sort = event.target.value; state.pageNumber = 1; await leadsPage(); }
    if (event.target.id === "takeover-range") { state.takeoverRange = event.target.value; await humanTakeoverPage(); }
    if (event.target.id === "takeover-handled") { state.takeoverHandled = event.target.value; await humanTakeoverPage(); }
    if (event.target.dataset.setting) { await patch("/system/settings", { [event.target.dataset.setting]: event.target.checked }); toast("Setting updated"); await controlPage(); }
  } catch (error) { toast(error.message, true); }
});
document.querySelector("#refresh").addEventListener("click", () => void render());
window.addEventListener("popstate", () => { applyLocation(); void render(); });
document.querySelector("#logout").addEventListener("click", async () => {
  try { await post("/auth/logout"); } finally { window.location.replace("/login.html"); }
});
(async () => {
  try {
    applyLocation();
    const session = await api("/auth/session");
    csrfToken = session.csrf_token;
    document.querySelector("#logout").hidden = !session.auth_enabled;
    await render();
  } catch (error) { if (error.message !== "Session expired") toast(error.message, true); }
})();
