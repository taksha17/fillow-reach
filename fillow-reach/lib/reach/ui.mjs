// fillow Reach local console — end-to-end UI for the whole pipeline:
// import → prospect → queue → drafts → approve/reject → contacts → report.
//
// Safety model (mirrors the fillow console invariants):
//   • binds 127.0.0.1 only; Host header must be loopback (DNS-rebinding guard)
//   • every POST carries the per-session token (X-Reach-Token)
//   • one run at a time — 409 while an agent is executing
//   • the UI can NEVER override dry_run and has no send button: outreach
//     composes only; the live send path stays in the profile + CLI (M5 bsk).
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

import { openReachMigratedDb } from "./db.mjs";
import {
  collectDashboard, markInviteSent, personTimeline,
} from "./dashboard-data.mjs";
import { importPaste } from "./import-paste.mjs";
import { addSuppression, forgetPerson } from "./people.mjs";
import { approveDraft } from "./send.mjs";
import { pause, resume } from "./killswitch.mjs";
import { buildDailyReport, renderReportText, reportDate } from "./report.mjs";
import { run as runProspect } from "../../agents/reach-prospect.mjs";
import { run as runOutreach } from "../../agents/reach-outreach.mjs";
import { run as runContacts } from "../../agents/reach-contacts.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;");
}

function profileHref(url) {
  const s = String(url || "").trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function personRowHtml(person, events) {
  const rows = (events ?? []).map((e) =>
    `<li><code>${escapeHtml(e.ts)}</code> ${escapeHtml(e.action)} <small>${escapeHtml(e.agent)} · ${escapeHtml(e.entity ?? "")}</small></li>`,
  ).join("") || "<li>none</li>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(person?.full_name)} — fillow Reach</title></head>
<body>
  <p><a href="/">← console</a></p>
  <h1>${escapeHtml(person?.full_name ?? "person")}</h1>
  <p>${escapeHtml(person?.title ?? "")} @ ${escapeHtml(person?.company ?? "")} · ${escapeHtml(person?.lifecycle ?? "")}</p>
  ${person?.linkedin_url ? `<p><a href="${escapeHtml(profileHref(person.linkedin_url))}" target="_blank" rel="noopener">LinkedIn profile</a></p>` : ""}
  <h2>Timeline</h2>
  <ul>${rows}</ul>
</body></html>`;
}

// The console shell is static; all data flows through /api/state and the page
// renders client-side with textContent-only assignment (no innerHTML on data),
// so LLM drafts and pasted text can never inject markup.
export function consolePageHtml(token) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>fillow Reach — console</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; background: #f4f5f7; color: #16171a; }
  @media (prefers-color-scheme: dark) { body { background: #14161a; color: #e6e7ea; } }
  header { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; padding: .8rem 1rem; background: #1f2937; color: #fff; }
  header h1 { font-size: 1.1rem; margin: 0; margin-right: .75rem; }
  .badge { padding: .15rem .5rem; border-radius: 999px; font-size: .75rem; font-weight: 600; }
  .badge.dry { background: #f59e0b; color: #201500; }
  .badge.live { background: #dc2626; color: #fff; }
  .badge.paused { background: #7c3aed; color: #fff; }
  .badge.busy { background: #2563eb; color: #fff; }
  nav { display: flex; flex-wrap: wrap; gap: .25rem; padding: .5rem 1rem 0; }
  nav button { border: 1px solid #c8ccd4; background: #fff; padding: .35rem .8rem; border-radius: .5rem .5rem 0 0; cursor: pointer; font-size: .85rem; }
  nav button.on { background: #2563eb; color: #fff; border-color: #2563eb; }
  @media (prefers-color-scheme: dark) { nav button { background: #1f2329; color: #e6e7ea; border-color: #333; } nav button.on { background: #2563eb; } }
  main { padding: 1rem; }
  section { display: none; background: #fff; border: 1px solid #d5d9e0; border-radius: .5rem; padding: 1rem; }
  section.on { display: block; }
  @media (prefers-color-scheme: dark) { section { background: #1a1d22; border-color: #2c313a; } }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #e3e6eb; vertical-align: top; }
  td.num { text-align: right; }
  .actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
  .actions button { padding: .4rem .9rem; border-radius: .5rem; border: 1px solid #2563eb; background: #2563eb; color: #fff; cursor: pointer; font-size: .85rem; }
  .actions button.warn { background: #7c3aed; border-color: #7c3aed; }
  .actions button:disabled { opacity: .5; cursor: wait; }
  textarea, input { font: inherit; padding: .4rem; border-radius: .4rem; border: 1px solid #c8ccd4; background: #fff; color: inherit; width: 100%; }
  @media (prefers-color-scheme: dark) { textarea, input { background: #14161a; border-color: #333; } }
  textarea { min-height: 9rem; }
  .muted { color: #6b7280; font-size: .8rem; }
  .flash { padding: .5rem .75rem; border-radius: .5rem; margin-bottom: .75rem; font-size: .85rem; display: none; }
  .flash.err { background: #fee2e2; color: #7f1d1d; display: block; }
  .flash.ok { background: #d1fae5; color: #064e3b; display: block; }
  .pill { display: inline-block; padding: 0 .4rem; border-radius: 999px; font-size: .72rem; font-weight: 600; }
  .pill.ok { background: #d1fae5; color: #065f46; }
  .pill.bad { background: #fee2e2; color: #991b1b; }
  .pill.dim { background: #e5e7eb; color: #374151; }
  pre.draft { white-space: pre-wrap; background: #f9fafb; border: 1px solid #e3e6eb; border-radius: .4rem; padding: .5rem; font-size: .8rem; }
  @media (prefers-color-scheme: dark) { pre.draft { background: #14161a; border-color: #2c313a; } }
</style>
</head>
<body data-token="${token}">
<header>
  <h1>fillow Reach</h1>
  <span id="badge-dry" class="badge dry">DRY RUN</span>
  <span id="badge-paused" class="badge paused" style="display:none">PAUSED</span>
  <span id="badge-busy" class="badge busy" style="display:none">running…</span>
  <span id="caps" class="muted" style="color:#cbd5e1"></span>
</header>
<nav id="tabs">
  <button data-tab="status" class="on">Status</button>
  <button data-tab="queue">Queue</button>
  <button data-tab="drafts">Drafts</button>
  <button data-tab="people">People</button>
  <button data-tab="targets">Targets</button>
  <button data-tab="activity">Activity</button>
  <button data-tab="import">Import</button>
</nav>
<main>
  <div id="flash" class="flash"></div>
  <div class="actions" id="actions">
    <button data-run="prospect" title="sync jobs.tsv targets + build the capped invite queue">▶ run prospect</button>
    <button data-run="outreach" title="compose drafts for eligible people (never sends)">✎ run outreach (compose)</button>
    <button data-run="contacts" title="IMAP acceptance/bounce detection + email enrichment">✉ run contacts</button>
    <button data-run="report" title="build the daily digest (does not email it)">▤ build report</button>
    <button id="toggle-pause" class="warn">⏸ pause</button>
  </div>

  <section id="tab-status" class="on">
    <table><tbody id="status-body"></tbody></table>
  </section>

  <section id="tab-queue">
    <p class="muted">Queued invites. After you send an invite manually on LinkedIn, "mark sent" records it — this is the queue-mode workflow (bsk auto-send is a separate milestone).</p>
    <table><thead><tr><th>#</th><th>person</th><th>title</th><th>company</th><th>score</th><th></th><th></th></tr></thead><tbody id="queue-body"></tbody></table>
  </section>

  <section id="tab-drafts">
    <p class="muted">Every composed draft with its grounding verdict. Approve/Reject only changes local state — nothing is sent from this console.</p>
    <div id="drafts-body"></div>
  </section>

  <section id="tab-people">
    <table><thead><tr><th>#</th><th>person</th><th>persona</th><th>company</th><th>lifecycle</th><th></th></tr></thead><tbody id="people-body"></tbody></table>
  </section>

  <section id="tab-targets">
    <p class="muted" id="targets-count"></p>
    <table><thead><tr><th>role</th><th>company</th><th>job_ref</th><th>status</th></tr></thead><tbody id="targets-body"></tbody></table>
  </section>

  <section id="tab-activity">
    <table><thead><tr><th>when</th><th>agent</th><th>action</th><th>detail</th></tr></thead><tbody id="activity-body"></tbody></table>
  </section>

  <section id="tab-import">
    <p class="muted">Paste LinkedIn search results or a company team page's text. Preview first, then write — review-first is enforced server-side.</p>
    <textarea id="paste-text" placeholder="Jane Doe — Technical Recruiter at Acme&#10;https://www.linkedin.com/in/jane-doe"></textarea>
    <div class="actions" style="margin-top:.5rem">
      <button id="paste-preview">preview</button>
      <button id="paste-apply">import (write)</button>
    </div>
    <div id="paste-result"></div>
    <hr>
    <p class="muted">Suppress a contact (email, LinkedIn URL, or domain):</p>
    <div class="actions"><input id="suppress-value" placeholder="person@company.test or linkedin.com/in/x or company.test" style="width:auto; flex:1"><button id="suppress-go">suppress</button></div>
  </section>
</main>
<script>
const TOKEN = document.body.dataset.token;
const $ = (id) => document.getElementById(id);
const flash = (msg, cls) => { const f = $("flash"); f.textContent = msg; f.className = "flash " + cls; setTimeout(() => { f.className = "flash"; }, 6000); };
const post = async (path, payload) => {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Reach-Token": TOKEN }, body: JSON.stringify(payload ?? {}) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { flash((body && body.error) || res.status + " " + res.statusText, "err"); throw new Error(body && body.error); }
  return body;
};
let STATE = null;

function td(text) { const c = document.createElement("td"); c.textContent = text ?? ""; return c; }
function tr(cells) { const r = document.createElement("tr"); for (const c of cells) r.appendChild(c); return r; }
function link(url, label) { const c = td(""); if (url) { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = label || "profile"; c.appendChild(a); } return c; }
function btn(label, fn, warn) { const c = td(""); const b = document.createElement("button"); b.textContent = label; if (warn) b.className = "warn"; b.onclick = fn; c.appendChild(b); return c; }
function pill(text, cls) { const c = td(""); const s = document.createElement("span"); s.className = "pill " + cls; s.textContent = text; c.appendChild(s); return c; }

function renderStatus() {
  const d = STATE, b = $("status-body");
  b.textContent = "";
  const kv = (k, v) => tr([td(k), td(v)]);
  b.appendChild(kv("mode", d.dryRun ? "DRY RUN — nothing sends until reach.dry_run flips in the profile" : "LIVE"));
  b.appendChild(kv("kill switch", d.paused ? "PAUSED" : "off"));
  b.appendChild(kv("funnel", Object.entries(d.funnel).map(([k, v]) => k + " " + v).join(" · ")));
  b.appendChild(kv("today", "invites " + (d.usage.day.invite || 0) + "/" + d.limits.invitesPerDay + " · emails " + (d.usage.day.email || 0) + "/" + d.limits.emailsPerDay));
  b.appendChild(kv("last 7d", "invites " + (d.usage.week.invite || 0) + "/" + d.limits.invitesPer7d + " · linkedin " + (d.usage.week.linkedin_message || 0) + "/" + d.limits.linkedinMessagesPer7d));
  const h = d.health || {};
  b.appendChild(kv("health", (h.acceptanceRate14d == null && h.bounceRate14d == null) ? "no data yet"
    : "acceptance " + Math.round((h.acceptanceRate14d || 0) * 100) + "% · bounce " + ((h.bounceRate14d || 0) * 100).toFixed(1) + "%"
      + (h.emailPaused ? " · EMAIL PAUSED" : "") + (h.halfTargets ? " · targets halved" : "")));
  b.appendChild(kv("queues", d.queue.length + " invites queued · " + d.approvals.length + " drafts awaiting approval"));
}

function renderQueue() {
  const b = $("queue-body");
  b.textContent = "";
  if (!STATE.queue.length) { b.appendChild(tr([td("— none —")])); return; }
  STATE.queue.forEach((r, i) => {
    const row = tr([
      td(String(i + 1)),
      link(r.linkedin_url ? (/^https?:\\/\\//.test(r.linkedin_url) ? r.linkedin_url : "https://" + r.linkedin_url) : "", r.full_name),
      td(r.title), td(r.company), td(String(r.relevance_score ?? "")),
      btn("open LinkedIn", () => { window.open((/^https?:\\/\\//.test(r.linkedin_url || "") ? r.linkedin_url : "https://" + (r.linkedin_url || "")), "_blank"); }),
      btn("mark sent", async () => { await post("/api/mark-sent", { personId: r.person_id }); flash("recorded as sent", "ok"); refresh(); }),
    ]);
    b.appendChild(row);
  });
}

function renderDrafts() {
  const b = $("drafts-body");
  b.textContent = "";
  if (!STATE.drafts.length) { b.textContent = "— none —"; return; }
  for (const d of STATE.drafts) {
    const card = document.createElement("div");
    card.style.marginBottom = "1rem";
    const head = document.createElement("div");
    const verdict = d.grounding_ok === 1 ? pill("grounded", "ok") : d.grounding_ok === 0 ? pill("grounding failed", "bad") : pill("unverified", "dim");
    head.append(String(d.id) + " · " + d.full_name + " · " + d.channel + " step " + d.step + " · " + d.status + " ");
    head.appendChild(verdict);
    card.appendChild(head);
    const pre = document.createElement("pre");
    pre.className = "draft";
    pre.textContent = (d.subject ? d.subject + "\\n\\n" : "") + d.body;
    card.appendChild(pre);
    if (d.grounding_notes) {
      const notes = document.createElement("p");
      notes.className = "muted";
      notes.textContent = "notes: " + d.grounding_notes;
      card.appendChild(notes);
    }
    const bar = document.createElement("div");
    bar.className = "actions";
    if (d.status === "needs_approval") {
      const ap = document.createElement("button"); ap.textContent = "approve"; ap.onclick = async () => { await post("/api/draft", { messageId: d.id, decision: "approve" }); flash("draft approved", "ok"); refresh(); };
      const rj = document.createElement("button"); rj.textContent = "reject"; rj.className = "warn"; rj.onclick = async () => { await post("/api/draft", { messageId: d.id, decision: "reject" }); flash("draft cancelled", "ok"); refresh(); };
      bar.append(ap, rj);
    }
    card.appendChild(bar);
    b.appendChild(card);
  }
}

function renderPeople() {
  const b = $("people-body");
  b.textContent = "";
  if (!STATE.people.length) { b.appendChild(tr([td("— none —")])); return; }
  STATE.people.forEach((p) => {
    const row = tr([
      td(String(p.id)),
      link("/person/" + p.id, p.full_name),
      td(p.lifecycle),
      td(""),
      td(p.do_not_contact ? "do-not-contact" : ""),
      btn("forget", async () => {
        if (!window.confirm("Erase " + p.full_name + " and all derived rows? This cannot be undone.")) return;
        try { await post("/api/forget", { personId: p.id, confirm: true }); flash("forgot", "ok"); refresh(); } catch { /* flash shown */ }
      }, true),
    ]);
    row.children[3].textContent = p.title || "";
    b.appendChild(row);
  });
}

function renderTargets() {
  const b = $("targets-body");
  b.textContent = "";
  $("targets-count").textContent = STATE.targets.length + " most recent target roles";
  STATE.targets.slice(0, 100).forEach((t) => b.appendChild(tr([td(t.title), td(t.company), td(t.job_ref), td(t.status ?? "")])));
}

function renderActivity() {
  const b = $("activity-body");
  b.textContent = "";
  STATE.events.slice(0, 100).forEach((e) => b.appendChild(tr([td(e.ts), td(e.agent), td(e.action), td(typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail ?? {}))])));
}

function render() {
  const d = STATE;
  $("badge-dry").textContent = d.dryRun ? "DRY RUN" : "LIVE";
  $("badge-dry").className = "badge " + (d.dryRun ? "dry" : "live");
  $("badge-paused").style.display = d.paused ? "" : "none";
  $("badge-busy").style.display = d.busy ? "" : "none";
  $("caps").textContent = "invites " + (d.usage.day.invite || 0) + "/" + d.limits.invitesPerDay + " today";
  $("toggle-pause").textContent = d.paused ? "▶ resume" : "⏸ pause";
  renderStatus(); renderQueue(); renderDrafts(); renderPeople(); renderTargets(); renderActivity();
}

async function refresh() {
  const res = await fetch("/api/state");
  STATE = await res.json();
  render();
}

document.querySelectorAll("#tabs button").forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.remove("on"));
    document.querySelectorAll("main section").forEach((x) => x.classList.remove("on"));
    t.classList.add("on");
    $("tab-" + t.dataset.tab).classList.add("on");
  };
});

document.querySelectorAll("#actions button[data-run]").forEach((b) => {
  b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await post("/api/run", { agent: b.dataset.run });
      if (r.text) flash(r.text.slice(0, 400), "ok");
      else flash(b.dataset.run + " done · " + JSON.stringify(r.stats || r), "ok");
    } catch { /* flash shown */ }
    b.disabled = false;
    refresh();
  };
});

$("toggle-pause").onclick = async () => {
  try { await post(STATE.paused ? "/api/resume" : "/api/pause"); flash(STATE.paused ? "resumed" : "paused — nothing sends", "ok"); refresh(); } catch { }
};

$("paste-preview").onclick = async () => {
  const text = $("paste-text").value;
  if (!text.trim()) return;
  const r = await post("/api/import-paste", { text, apply: false });
  $("paste-result").textContent = "parsed " + r.parsed + " — preview:\\n" + r.preview.map((p) => p.full_name + " · " + (p.title || "?") + (p.company ? " @ " + p.company : "")).join("\\n");
};

$("paste-apply").onclick = async () => {
  const text = $("paste-text").value;
  if (!text.trim()) return;
  if (!window.confirm("Import the pasted people into the database?")) return;
  const r = await post("/api/import-paste", { text, apply: true });
  $("paste-result").textContent = "imported " + r.imported + (r.skipped ? ", skipped " + r.skipped : "");
  flash("imported " + r.imported, "ok");
  refresh();
};

$("suppress-go").onclick = async () => {
  const value = $("suppress-value").value.trim();
  if (!value) return;
  await post("/api/suppress", { value });
  flash("suppressed " + value, "ok");
  $("suppress-value").value = "";
  refresh();
};

refresh();
setInterval(refresh, 5000);
</script>
</body></html>`;
}

export function startReachUi(reachCfg, { port = 4181, host = "127.0.0.1" } = {}) {
  const token = randomBytes(24).toString("hex");
  let busy = false;

  const guardHost = (req) => {
    const h = String(req.headers.host || "").split(":")[0];
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
  };

  async function runAgent(agent) {
    if (agent === "prospect") {
      const r = await runProspect(reachCfg, { emit: () => {} });
      return { agent, stats: { targets: r.targets, queued: r.queued, skipped: r.skipped } };
    }
    if (agent === "outreach") {
      const r = await runOutreach(reachCfg, { compose: true, send: false, emit: () => {} });
      return { agent, stats: r };
    }
    if (agent === "contacts") {
      if (!reachCfg.mail.configured) return { agent, stats: { skipped: "mailbox not configured" } };
      const r = await runContacts(reachCfg);
      return { agent, stats: r };
    }
    if (agent === "report") {
      const db = openReachMigratedDb(reachCfg);
      try {
        const built = buildDailyReport(db, reachCfg, { date: reportDate(new Date(), reachCfg.report.timezone) });
        return { agent, text: renderReportText(built), stats: { date: built.date ?? "" } };
      } finally {
        db.close();
      }
    }
    throw new Error(`unknown agent: ${agent}`);
  }

  const server = createServer(async (req, res) => {
    const send = (status, body, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      if (!guardHost(req)) {
        send(403, { error: "loopback only" });
        return;
      }
      const u = new URL(req.url || "/", `http://${host}`);

      if (req.method === "GET" && u.pathname === "/") {
        send(200, consolePageHtml(token), "text/html; charset=utf-8");
        return;
      }

      if (req.method === "GET" && u.pathname === "/api/state") {
        const db = openReachMigratedDb(reachCfg);
        let data;
        try {
          data = collectDashboard(db, reachCfg);
        } finally {
          db.close();
        }
        send(200, { ...data, busy });
        return;
      }

      if (req.method === "GET" && /^\/person\/\d+$/.test(u.pathname)) {
        const id = Number(u.pathname.split("/")[2]);
        const db = openReachMigratedDb(reachCfg);
        try {
          const person = db.prepare(
            `SELECT p.id, p.full_name, p.title, p.lifecycle, p.linkedin_url, c.name AS company
             FROM person p LEFT JOIN company c ON c.id = p.company_id WHERE p.id = ?`,
          ).get(id);
          send(200, personRowHtml(person, personTimeline(db, id)), "text/html; charset=utf-8");
        } finally {
          db.close();
        }
        return;
      }

      if (req.method === "POST" && u.pathname.startsWith("/api/")) {
        if (req.headers["x-reach-token"] !== token) {
          send(403, { error: "bad or missing token" });
          return;
        }
        let body = {};
        if ((req.headers["content-length"] ?? "0") !== "0") {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw || "{}");
        }

        if (u.pathname === "/api/state") { send(200, { ok: true }); return; }

        if (u.pathname === "/api/pause") {
          pause(reachCfg, "ui");
          send(200, { paused: true });
          return;
        }
        if (u.pathname === "/api/resume") {
          resume(reachCfg);
          send(200, { paused: false });
          return;
        }

        if (u.pathname === "/api/suppress") {
          const value = String(body.value ?? "").trim();
          if (!value) { send(400, { error: "value required" }); return; }
          const kind = String(body.kind || (value.includes("@") ? "email" : /linkedin\./i.test(value) ? "linkedin_url" : "domain"));
          const db = openReachMigratedDb(reachCfg);
          try {
            // reason is CHECK-constrained (optout|bounce|manual|complaint) — the
            // console's own entries record as manual.
            const id = addSuppression(db, { kind, value, reason: "manual" });
            send(200, { id, kind });
          } finally {
            db.close();
          }
          return;
        }

        if (u.pathname === "/api/forget") {
          if (!body.confirm) { send(400, { error: "confirm required" }); return; }
          const db = openReachMigratedDb(reachCfg);
          try {
            const r = forgetPerson(db, Number(body.personId));
            if (!r?.ok) { send(404, { error: "no such person" }); return; }
            send(200, { ok: true });
          } finally {
            db.close();
          }
          return;
        }

        if (u.pathname === "/api/mark-sent") {
          const db = openReachMigratedDb(reachCfg);
          try {
            markInviteSent(db, Number(body.personId));
            send(200, { ok: true });
          } finally {
            db.close();
          }
          return;
        }

        if (u.pathname === "/api/import-paste") {
          const text = String(body.text ?? "");
          if (!text.trim()) { send(400, { error: "text required" }); return; }
          const db = openReachMigratedDb(reachCfg);
          try {
            const r = importPaste(db, text, { apply: Boolean(body.apply) });
            send(200, r);
          } finally {
            db.close();
          }
          return;
        }

        if (u.pathname === "/api/draft") {
          const messageId = Number(body.messageId);
          const decision = String(body.decision ?? "");
          const db = openReachMigratedDb(reachCfg);
          try {
            if (decision === "approve") {
              approveDraft(db, messageId, { by: "ui" });
              send(200, { ok: true, status: "approved" });
              return;
            }
            if (decision === "reject") {
              const r = db.prepare("UPDATE message SET status='cancelled' WHERE id=? AND direction='out'").run(messageId);
              send(200, r.changes ? { ok: true, status: "cancelled" } : { error: "no such draft" });
              return;
            }
            send(400, { error: "decision must be approve|reject" });
          } finally {
            db.close();
          }
          return;
        }

        if (u.pathname === "/api/run") {
          if (busy) { send(409, { error: "a run is already in progress" }); return; }
          busy = true;
          try {
            const r = await runAgent(String(body.agent ?? ""));
            send(200, r);
          } finally {
            busy = false;
          }
          return;
        }

        send(404, { error: "unknown api path" });
        return;
      }

      send(404, { error: "not found" });
    } catch (err) {
      send(500, { error: String(err.message || err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, token, url: `http://${host}:${actualPort}`, port: actualPort });
    });
  });
}
