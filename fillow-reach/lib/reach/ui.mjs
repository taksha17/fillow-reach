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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOGO_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "fillow_logo.png");

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
import { importPublicPage } from "./public-pages.mjs";
import { runDailyCycle } from "./run.mjs";

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
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/logo.png">
<title>${escapeHtml(person?.full_name)} — fillow Reach</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@1,9..144,560&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
  :root {
    --bg: #100f0c; --panel: #181612; --ink: #f4efe6; --mute: #9c9488;
    --line: #2a261f; --gold: #e0a14a; --moss: #7dba7a; --rose: #d46a5c;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); }
  body { min-height: 100vh; font: 15px/1.45 "IBM Plex Sans", ui-sans-serif, sans-serif; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 28px 28px 64px; }
  a { color: var(--gold); text-decoration: underline; text-underline-offset: 3px; }
  h1.mark { margin: 0; font-family: Fraunces, Georgia, serif; font-style: italic; font-size: 2rem; font-weight: 560; letter-spacing: -.03em; }
  h2 { font-family: Fraunces, Georgia, serif; font-style: italic; font-weight: 560; font-size: 1.3rem; }
  .sub { margin: 4px 0 0; color: var(--mute); }
  ul.timeline { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
  ul.timeline li { padding: .55rem 0 .55rem .75rem; border-bottom: 1px solid var(--line); border-left: 2px solid var(--line); }
  code { color: var(--mute); font-size: .92em; }
  small { color: var(--mute); }
  @media (max-width: 800px) { .wrap { padding: 20px 16px 48px; } }
</style>
</head>
<body>
<div class="wrap">
  <p><img class="logo" src="/logo.png" alt="fillow" style="height:28px;width:28px;object-fit:contain;vertical-align:middle;margin-right:6px"><a href="/">← console</a></p>
  <h1 class="mark">${escapeHtml(person?.full_name ?? "person")}</h1>
  <p class="sub">${escapeHtml(person?.title ?? "")} @ ${escapeHtml(person?.company ?? "")} · ${escapeHtml(person?.lifecycle ?? "")}</p>
  ${person?.linkedin_url ? `<p><a href="${escapeHtml(profileHref(person.linkedin_url))}" target="_blank" rel="noopener">LinkedIn profile</a></p>` : ""}
  <h2>Timeline</h2>
  <ul class="timeline">${rows}</ul>
</div>
</body></html>`;
}

// The console shell is static; all data flows through /api/state and the page
// renders client-side with textContent-only assignment (no innerHTML on data),
// so LLM drafts and pasted text can never inject markup.
export function consolePageHtml(token) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/logo.png">
<title>fillow Reach — console</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@1,9..144,560&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
  :root {
    --bg: #100f0c; --panel: #181612; --ink: #f4efe6; --mute: #9c9488;
    --line: #2a261f; --gold: #e0a14a; --moss: #7dba7a; --rose: #d46a5c;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); }
  body { min-height: 100vh; font: 15px/1.45 "IBM Plex Sans", ui-sans-serif, sans-serif; }
  a { color: inherit; }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 28px 28px 64px; }
  header.top { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding-bottom: 22px; }
  header.top img.logo { height: 38px; width: 38px; object-fit: contain; }
  header.top h1.mark { margin: 0; margin-right: .75rem; font-family: Fraunces, Georgia, serif; font-style: italic; font-size: 2rem; font-weight: 560; letter-spacing: -.03em; }
  .badge { padding: .15rem .6rem; border: 1px solid var(--line); border-radius: 999px; font-size: .68rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
  .badge.dry { color: var(--gold); border-color: var(--gold); }
  .badge.live { color: var(--moss); border-color: var(--moss); }
  .badge.paused { color: var(--rose); border-color: var(--rose); }
  .badge.busy { color: var(--gold); }
  nav.pipe { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0; border: 1px solid var(--line); background: var(--panel); }
  nav.pipe button { position: relative; padding: 12px 10px 13px; border: 0; border-right: 1px solid var(--line); background: transparent; color: var(--mute); font: 600 .82rem/1.2 "IBM Plex Sans", sans-serif; cursor: pointer; }
  nav.pipe button:last-child { border-right: 0; }
  nav.pipe button.on { color: var(--ink); background: #1f1c16; }
  nav.pipe button.on::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: 0; height: 2px; background: var(--gold); }
  main { padding: 0; }
  section { display: none; background: var(--panel); border: 1px solid var(--line); border-top: 0; padding: 1rem 1.25rem; }
  section.on { display: block; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th { text-align: left; padding: .45rem .55rem; border-bottom: 1px solid var(--line); color: var(--mute); font-size: .68rem; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; }
  td { text-align: left; padding: .45rem .55rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.num { text-align: right; }
  .actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
  .btn-gold { background: linear-gradient(180deg, #edbb6a, var(--gold)); color: #20180a; border: 0; padding: 9px 18px; font: 600 .9rem/1 "IBM Plex Sans", sans-serif; cursor: pointer; }
  .btn-gold:disabled { opacity: .55; cursor: wait; }
  .btn-ghost { background: transparent; color: var(--mute); border: 1px solid var(--line); padding: 8px 14px; font: 600 .85rem/1 "IBM Plex Sans", sans-serif; cursor: pointer; }
  .btn-ghost:hover { color: var(--ink); border-color: var(--gold); }
  .btn-ghost:disabled { opacity: .55; cursor: wait; }
  .btn-warn { color: var(--rose); border-color: var(--rose); }
  .btn-warn:hover { color: var(--rose); border-color: var(--rose); background: #1f1c16; }
  textarea, input { font: inherit; padding: 7px 9px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); width: 100%; }
  textarea:focus, input:focus { outline: none; border-color: var(--gold); }
  textarea { min-height: 9rem; }
  .muted { color: var(--mute); font-size: .8rem; }
  .flash { padding: .5rem .75rem; border: 1px solid var(--line); background: var(--panel); margin-bottom: .75rem; font-size: .85rem; display: none; }
  .flash.err { color: var(--rose); border-color: var(--rose); display: block; }
  .flash.ok { color: var(--moss); border-color: var(--moss); display: block; }
  .pill { display: inline-block; padding: 0 .4rem; border: 1px solid var(--line); border-radius: 999px; font-size: .72rem; font-weight: 600; }
  .pill.ok { color: var(--moss); border-color: var(--moss); }
  .pill.bad { color: var(--rose); border-color: var(--rose); }
  .pill.dim { color: var(--mute); }
  pre.draft { white-space: pre-wrap; background: var(--bg); border: 1px solid var(--line); padding: .5rem; font-size: .8rem; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 1rem 0; }
  @media (max-width: 800px) {
    .wrap { padding: 20px 16px 48px; }
    nav.pipe { grid-template-columns: 1fr 1fr; }
    nav.pipe button { border-bottom: 1px solid var(--line); }
  }
</style>
</head>
<body data-token="${token}">
<div class="wrap">
<header class="top">
  <img class="logo" src="/logo.png" alt="fillow">
  <h1 class="mark">fillow Reach</h1>
  <span id="badge-dry" class="badge dry" title="Practice mode: nothing gets sent. To go live, change reach.dry_run to false in your profile yourself.">Practice mode</span>
  <span id="badge-paused" class="badge paused" style="display:none">PAUSED</span>
  <span id="badge-busy" class="badge busy" style="display:none">working…</span>
  <span id="caps" class="muted"></span>
</header>
<nav id="tabs" class="pipe">
  <button data-tab="status" class="on">Overview</button>
  <button data-tab="queue">Invites to send</button>
  <button data-tab="drafts">Messages to review</button>
  <button data-tab="people">People</button>
  <button data-tab="targets">Job targets</button>
  <button data-tab="activity">History</button>
  <button data-tab="import">Add people</button>
</nav>
<main>
  <div id="flash" class="flash"></div>
  <div class="actions" id="actions">
    <button class="btn-gold" data-run="daily" title="Runs today's full cycle: find people to invite, check the inbox, write drafts, archive events. Nothing is emailed or sent from this console.">Run today's cycle</button>
    <button class="btn-gold" data-run="prospect" title="Picks the best people to invite from the people you've added — ones who work at your target companies (max 15/day). Add people first under 'Add people'.">Find people to invite</button>
    <button class="btn-gold" data-run="outreach" title="Writes polite draft messages for accepted connections. Nothing is sent from this console.">Write draft messages</button>
    <button class="btn-gold" data-run="contacts" title="Reads your inbox: who accepted your invitations, bounced emails, and finds verified emails.">Check for acceptances</button>
    <button class="btn-gold" data-run="report" title="Builds today's summary. Does not email it.">Today's summary</button>
    <button id="toggle-pause" class="btn-ghost btn-warn">Pause everything</button>
  </div>

  <section id="tab-status" class="on">
    <table><tbody id="status-body"></tbody></table>
  </section>

  <section id="tab-queue">
    <p class="muted">People the tool suggests inviting. Send the invite yourself on LinkedIn, then press "I sent this" so the tool records it. (Sending is always manual — the tool never touches your LinkedIn.)</p>
    <table><thead><tr><th>#</th><th>who</th><th>their job</th><th>company</th><th>match score</th><th></th><th></th></tr></thead><tbody id="queue-body"></tbody></table>
  </section>

  <section id="tab-drafts">
    <p class="muted">Draft messages the tool wrote for you, with a fact-check verdict: every claim must come from your own profile and resume. Approve the good ones, discard the rest — nothing is sent from this page.</p>
    <div id="drafts-body"></div>
  </section>

  <section id="tab-people">
    <table><thead><tr><th>#</th><th>person</th><th>stage</th><th>their job</th><th></th><th></th></tr></thead><tbody id="people-body"></tbody></table>
  </section>

  <section id="tab-targets">
    <p class="muted" id="targets-count"></p>
    <table><thead><tr><th>job</th><th>company</th><th>reference</th><th>status</th></tr></thead><tbody id="targets-body"></tbody></table>
  </section>

  <section id="tab-activity">
    <p class="muted">Everything the tool did, newest first.</p>
    <table><thead><tr><th>when</th><th>who</th><th>what</th><th>details</th></tr></thead><tbody id="activity-body"></tbody></table>
  </section>

  <section id="tab-import">
    <p class="muted"><strong>Fetch a public team page</strong> — paste a company's "Team"/"About" URL and the tool reads the public page (robots-aware; sites that refuse are skipped cleanly).</p>
    <div class="actions">
      <input id="page-url" placeholder="https://company.example/team" style="width:auto; flex:1">
      <button id="page-go" class="btn-gold" title="Reads the public web page; never logs in, never sends anything.">Fetch team page</button>
    </div>
    <div id="page-result"></div>
    <hr>
    <p class="muted">Or paste LinkedIn search results / a company team page's text below. You'll see a preview before anything is saved.</p>
    <textarea id="paste-text" placeholder="Jane Doe — Technical Recruiter at Acme&#10;https://www.linkedin.com/in/jane-doe"></textarea>
    <div class="actions" style="margin-top:.5rem">
      <button id="paste-preview" class="btn-ghost">Preview</button>
      <button id="paste-apply" class="btn-gold">Save these people</button>
    </div>
    <div id="paste-result"></div>
    <hr>
    <p class="muted">Never contact someone again — add their email, LinkedIn page, or whole company domain:</p>
    <div class="actions"><input id="suppress-value" placeholder="person@company.test, linkedin.com/in/x, or company.test" style="width:auto; flex:1"><button id="suppress-go" class="btn-ghost btn-warn">Never contact</button></div>
  </section>
</main>
</div>
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
function btn(label, fn, warn) { const c = td(""); const b = document.createElement("button"); b.textContent = label; b.className = "btn-ghost" + (warn ? " btn-warn" : ""); b.onclick = fn; c.appendChild(b); return c; }
function pill(text, cls) { const c = td(""); const s = document.createElement("span"); s.className = "pill " + cls; s.textContent = text; c.appendChild(s); return c; }

function renderStatus() {
  const d = STATE, b = $("status-body");
  b.textContent = "";
  const kv = (k, v) => tr([td(k), td(v)]);
  if (!d.people.length) {
    const step = (n, label, done) => {
      const c1 = td("");
      const s = document.createElement("span");
      s.textContent = done ? "\u2714" : n;
      s.style.fontWeight = "bold";
      c1.appendChild(s);
      const row = tr([c1, td("")]);
      row.children[1].textContent = (done ? "" : "\u2190 do this next: ") + label;
      if (!done) row.children[1].style.fontWeight = "600";
      b.appendChild(row);
    };
    step(1, "Load your job list (data/jobs.tsv)", d.targets.length > 0);
    step(2, "Add people — fetch a company's team page, paste a LinkedIn search page, or import your Connections.csv  (under \u201cAdd people\u201d)", false);
    step(3, "Press \u201cFind people to invite\u201d", false);
    const gap = tr([td(""), td("")]);
    gap.children[1].textContent = "\u2014 your details below \u2014";
    gap.children[1].className = "muted";
    b.appendChild(gap);
  }
  b.appendChild(kv("Sending mode", d.dryRun ? "Practice — nothing gets sent. To go live, set reach.dry_run to false in your profile." : "LIVE — approved messages will really send"));
  b.appendChild(kv("Paused?", d.paused ? "Yes — nothing will run" : "No"));
  b.appendChild(kv("People by stage", Object.entries(d.funnel).map(([k, v]) => k + " " + v).join(" · ")));
  b.appendChild(kv("Invites used today", (d.usage.day.invite || 0) + " of " + d.limits.invitesPerDay));
  b.appendChild(kv("Invites used this week", (d.usage.week.invite || 0) + " of " + d.limits.invitesPer7d));
  b.appendChild(kv("Messages this week", (d.usage.week.linkedin_message || 0) + " of " + d.limits.linkedinMessagesPer7d + " LinkedIn · " + (d.usage.day.email || 0) + " of " + d.limits.emailsPerDay + " emails today"));
  const h = d.health || {};
  b.appendChild(kv("Response health", (h.acceptanceRate14d == null && h.bounceRate14d == null) ? "no data yet — appears once you have replies/bounces"
    : Math.round((h.acceptanceRate14d || 0) * 100) + "% accept · " + ((h.bounceRate14d || 0) * 100).toFixed(1) + "% bounce"
      + (h.emailPaused ? " — email paused (too many bounces)" : "") + (h.halfTargets ? " — invite target halved (low acceptance)" : "")));
  b.appendChild(kv("Waiting on you", d.queue.length + " invites to send · " + d.approvals.length + " drafts to review"));
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
      btn("I sent this", async () => { await post("/api/mark-sent", { personId: r.person_id }); flash("recorded as sent", "ok"); refresh(); }),
    ]);
    b.appendChild(row);
  });
}

const friendlyStatus = { needs_approval: "awaiting your review", approved: "approved (ready to send)", cancelled: "discarded", sent: "sent", queued: "ready to send" };
const friendlyChannel = { linkedin: "LinkedIn message", email: "email" };

function renderDrafts() {
  const b = $("drafts-body");
  b.textContent = "";
  if (!STATE.drafts.length) { b.textContent = "— nothing yet. Drafts appear here after you press \u201cWrite draft messages\u201d and someone has accepted your invite. —"; return; }
  for (const d of STATE.drafts) {
    const card = document.createElement("div");
    card.style.marginBottom = "1rem";
    const head = document.createElement("div");
    const verdict = d.grounding_ok === 1 ? pill("facts verified", "ok") : d.grounding_ok === 0 ? pill("needs a fact-check", "bad") : pill("not checked", "dim");
    head.append("Draft #" + d.id + " for " + d.full_name + " · " + (friendlyChannel[d.channel] || d.channel) + (d.step === 2 ? " (follow-up)" : "") + " · " + (friendlyStatus[d.status] || d.status) + " ");
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
      const ap = document.createElement("button"); ap.className = "btn-gold"; ap.textContent = "Approve"; ap.title = "Mark this draft as good. It will only actually send when you run the send step yourself."; ap.onclick = async () => { await post("/api/draft", { messageId: d.id, decision: "approve" }); flash("draft approved", "ok"); refresh(); };
      const rj = document.createElement("button"); rj.textContent = "Discard"; rj.className = "btn-ghost btn-warn"; rj.onclick = async () => { await post("/api/draft", { messageId: d.id, decision: "reject" }); flash("draft discarded", "ok"); refresh(); };
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
      btn("Delete", async () => {
        if (!window.confirm("Erase " + p.full_name + " and everything the tool knows about them? This cannot be undone.")) return;
        try { await post("/api/forget", { personId: p.id, confirm: true }); flash("deleted", "ok"); refresh(); } catch { /* flash shown */ }
      }, true),
    ]);
    row.children[3].textContent = p.title || "";
    b.appendChild(row);
  });
}

function renderTargets() {
  const b = $("targets-body");
  b.textContent = "";
  $("targets-count").textContent = "Jobs you're currently targeting — the tool prefers inviting people who work at these companies. Newest first.";
  STATE.targets.slice(0, 100).forEach((t) => b.appendChild(tr([td(t.title), td(t.company), td(t.job_ref), td(t.status ?? "")])));
}

function renderActivity() {
  const b = $("activity-body");
  b.textContent = "";
  STATE.events.slice(0, 100).forEach((e) => b.appendChild(tr([td(e.ts), td(e.agent), td(e.action), td(typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail ?? {}))])));
}

function render() {
  const d = STATE;
  $("badge-dry").textContent = d.dryRun ? "Practice mode" : "LIVE";
  $("badge-dry").className = "badge " + (d.dryRun ? "dry" : "live");
  $("badge-paused").style.display = d.paused ? "" : "none";
  $("badge-busy").style.display = d.busy ? "" : "none";
  $("caps").textContent = (d.usage.day.invite || 0) + " of " + d.limits.invitesPerDay + " invites used today";
  $("toggle-pause").textContent = d.paused ? "Resume" : "Pause everything";
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

const runDoneText = {
  daily: "Today's cycle finished — review drafts under \u201cMessages to review\u201d",
  prospect: "Invite list updated",
  outreach: "Drafts written — review them under \u201cMessages to review\u201d",
  contacts: "Inbox checked — acceptances and bounces recorded",
  report: "Today's summary is built",
};

function runFlash(agent, r) {
  if (r.text) return r.text.slice(0, 400);
  if (agent === "prospect" && r.stats) {
    if (r.stats.queued > 0) return "Added " + r.stats.queued + " " + (r.stats.queued === 1 ? "person" : "people") + " to \u201cInvites to send\u201d";
    if (r.stats.targets > 0 && STATE && STATE.people.length === 0) {
      return "No one to invite yet — your people list is empty. Open \u201cAdd people\u201d and paste a LinkedIn search results page (or import your Connections.csv), then press this again.";
    }
    if (r.stats.targets > 0) return "No new invites — everyone currently on your list is already invited, blocked, or not relevant enough yet.";
    return "No job targets found — add a jobs.tsv to data/ so the tool knows which companies matter to you.";
  }
  return runDoneText[agent] || "Done";
}

document.querySelectorAll("#actions button[data-run]").forEach((b) => {
  b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await post("/api/run", { agent: b.dataset.run });
      flash(runFlash(b.dataset.run, r), r.stats && b.dataset.run === "prospect" && r.stats.queued === 0 ? "err" : "ok");
    } catch { /* flash shown */ }
    b.disabled = false;
    refresh();
  };
});

$("toggle-pause").onclick = async () => {
  try { await post(STATE.paused ? "/api/resume" : "/api/pause"); flash(STATE.paused ? "resumed" : "paused — nothing sends", "ok"); refresh(); } catch { }
};

$("page-go").onclick = async () => {
  const btn = $("page-go");
  const url = $("page-url").value.trim();
  if (!url) return;
  btn.disabled = true;
  $("page-result").textContent = "Reading the page…";
  try {
    const r = await post("/api/fetch-page", { url });
    if (r.reason === "blocked") {
      $("page-result").textContent = "That page refused visitors — try pasting its text in the box below instead.";
      flash("page blocked", "err");
    } else if (r.reason === "not_found") {
      $("page-result").textContent = "No page there (404). Check the URL.";
      flash("page not found", "err");
    } else if (r.imported > 0) {
      $("page-result").textContent = "Saved " + r.imported + (r.imported === 1 ? " person" : " people") + (r.skipped ? " (" + r.skipped + " blocked/duplicates skipped)" : "") + ". Now press \u201cFind people to invite\u201d up top.";
      flash("saved", "ok");
      $("page-url").value = "";
    } else {
      $("page-result").textContent = "No people's names found on that page — it may be a JS-heavy site. Paste its text in the box below instead.";
      flash("nothing found", "err");
    }
    refresh();
  } catch { /* flash shown */ }
  btn.disabled = false;
};

$("paste-preview").onclick = async () => {
  const text = $("paste-text").value;
  if (!text.trim()) return;
  const r = await post("/api/import-paste", { text, apply: false });
  $("paste-result").textContent = "Found " + r.parsed + " " + (r.parsed === 1 ? "person" : "people") + " — check them, then press \u201cSave these people\u201d:\\n" + r.preview.map((p) => p.full_name + " · " + (p.title || "?") + (p.company ? " @ " + p.company : "")).join("\\n");
};

$("paste-apply").onclick = async () => {
  const text = $("paste-text").value;
  if (!text.trim()) return;
  if (!window.confirm("Save the pasted people to your list?")) return;
  const r = await post("/api/import-paste", { text, apply: true });
  $("paste-result").textContent = "Saved " + r.imported + (r.skipped ? " (" + r.skipped + " skipped — blocked or duplicates)" : "");
  flash("saved", "ok");
  refresh();
};

$("suppress-go").onclick = async () => {
  const value = $("suppress-value").value.trim();
  if (!value) return;
  await post("/api/suppress", { value });
  flash("OK — they won't be contacted", "ok");
  $("suppress-value").value = "";
  refresh();
};

refresh();
setInterval(refresh, 5000);
</script>
</body></html>`;
}

export function startReachUi(reachCfg, { port = 4181, host = "127.0.0.1", fetchImpl = null } = {}) {
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
    if (agent === "daily") {
      const r = await runDailyCycle(reachCfg, { send: false, emit: () => {} });
      return { agent, stats: r, text: r.errors.length ? r.errors.map((e) => `${e.agent}: ${e.error}`).join("; ") : "" };
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

      if (req.method === "GET" && u.pathname === "/logo.png") {
        let logo;
        try {
          logo = readFileSync(LOGO_PATH);
        } catch {
          send(404, { error: "logo not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
          "Content-Length": logo.length,
        });
        res.end(logo);
        return;
      }

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

        if (u.pathname === "/api/fetch-page") {
          if (busy) { send(409, { error: "a run is already in progress" }); return; }
          const url = String(body.url ?? "").trim();
          if (!/^https?:\/\//i.test(url)) { send(400, { error: "paste a full page URL (https://company.example/team)" }); return; }
          busy = true;
          const db = openReachMigratedDb(reachCfg);
          try {
            const r = await importPublicPage(db, url, { fetchImpl: fetchImpl ?? undefined });
            send(200, r);
          } finally {
            busy = false;
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
