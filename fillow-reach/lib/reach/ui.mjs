import { createServer } from "node:http";

import { openReachMigratedDb } from "./db.mjs";
import { collectDashboard, markInviteSent, personTimeline } from "./dashboard-data.mjs";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function profileHref(url) {
  const s = String(url || "").trim();
  if (!s) return "#";
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function preview(body, n = 80) {
  const t = String(body || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function healthLine(health) {
  if (!health || (health.acceptanceRate14d == null && health.bounceRate14d == null)) return "no data yet";
  const a = health.acceptanceRate14d == null ? "—" : `${Math.round(health.acceptanceRate14d * 100)}%`;
  const b = health.bounceRate14d == null ? "—" : `${((health.bounceRate14d) * 100).toFixed(1)}%`;
  return `acceptance ${a} · bounce ${b}${health.halfTargets ? " · halved targets" : ""}${health.emailPaused ? " · email paused" : ""}`;
}

export function renderDashboardHtml(data = {}) {
  const funnel = data.funnel ?? {};
  const queue = data.queue ?? [];
  const approvals = data.approvals ?? [];
  const people = data.people ?? [];
  const usage = data.usage ?? { day: {}, week: {} };
  const L = data.limits ?? {};
  const errors = data.errors ?? [];
  const paused = Boolean(data.paused);

  const funnelBits = ["prospect", "invited", "connected", "messaged", "replied", "closed", "suppressed"]
    .map((k) => `${k} ${funnel[k] ?? 0}`)
    .join(" · ");

  const queueRows = queue.map((row) => {
    const href = escapeHtml(profileHref(row.linkedin_url));
    const name = escapeHtml(row.full_name);
    return `<li>${name} — ${escapeHtml(row.title ?? "")} @ ${escapeHtml(row.company ?? "")}
      <a href="${href}">profile</a>
      <form method="post" action="/mark-sent/${Number(row.person_id)}" style="display:inline">
        <button type="submit">mark sent</button>
      </form></li>`;
  }).join("") || "<li>none</li>";

  const approvalRows = approvals.map((row) =>
    `<li>${escapeHtml(row.full_name)} · ${escapeHtml(row.channel)} · ${escapeHtml(preview(row.body))}</li>`,
  ).join("") || "<li>none</li>";

  const peopleRows = people.map((row) =>
    `<li><a href="/person/${Number(row.id)}">${escapeHtml(row.full_name)}</a> · ${escapeHtml(row.lifecycle ?? "")}</li>`,
  ).join("") || "<li>none</li>";

  const errorRows = errors.map((row) =>
    `<li>${escapeHtml(row.kind ?? "error")} ${escapeHtml(row.action ?? row.status ?? "")} ${escapeHtml(row.agent ?? "")}</li>`,
  ).join("") || "<li>none</li>";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>fillow Reach</title></head>
<body>
  <h1>fillow Reach</h1>
  ${paused ? "<p><strong>PAUSED</strong> — mark-sent still records a manual send.</p>" : ""}
  <h2>Funnel</h2>
  <p>${escapeHtml(funnelBits)}</p>
  <h2>Today's queue</h2>
  <ul>${queueRows}</ul>
  <h2>Approvals</h2>
  <ul>${approvalRows}</ul>
  <h2>People</h2>
  <ul>${peopleRows}</ul>
  <h2>Usage vs caps</h2>
  <p>today invites ${usage.day?.invite ?? 0}/${L.invitesPerDay ?? 15} · emails ${usage.day?.email ?? 0}/${L.emailsPerDay ?? 15}</p>
  <p>7d invites ${usage.week?.invite ?? 0}/${L.invitesPer7d ?? 75} · linkedin ${usage.week?.linkedin_message ?? 0}/${L.linkedinMessagesPer7d ?? 75}</p>
  <h2>Health</h2>
  <p>${escapeHtml(healthLine(data.health))}</p>
  <h2>Errors</h2>
  <ul>${errorRows}</ul>
</body></html>`;
}

function renderPersonHtml(person, events) {
  const rows = (events ?? []).map((e) =>
    `<li>${escapeHtml(e.ts)} ${escapeHtml(e.action)} ${escapeHtml(e.entity)}</li>`,
  ).join("") || "<li>none</li>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(person?.full_name)}</title></head>
<body>
  <p><a href="/">← dashboard</a></p>
  <h1>${escapeHtml(person?.full_name ?? "person")}</h1>
  <p>${escapeHtml(person?.title ?? "")} @ ${escapeHtml(person?.company ?? "")} · ${escapeHtml(person?.lifecycle ?? "")}</p>
  <h2>Timeline</h2>
  <ul>${rows}</ul>
</body></html>`;
}

export function startReachUi(reachCfg, { port = 4181, host = "127.0.0.1" } = {}) {
  const server = createServer((req, res) => {
    const db = openReachMigratedDb(reachCfg);
    try {
      const u = new URL(req.url || "/", `http://${host}`);
      if (req.method === "POST") {
        const m = u.pathname.match(/^\/mark-sent\/(\d+)$/);
        if (m) {
          markInviteSent(db, Number(m[1]));
          res.writeHead(302, { Location: "/" });
          res.end();
          return;
        }
      }
      if (req.method === "GET" && /^\/person\/\d+$/.test(u.pathname)) {
        const id = Number(u.pathname.split("/")[2]);
        const person = db.prepare(
          `SELECT p.id, p.full_name, p.title, p.lifecycle, c.name AS company
           FROM person p LEFT JOIN company c ON c.id = p.company_id WHERE p.id = ?`,
        ).get(id);
        const html = renderPersonHtml(person, personTimeline(db, id));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      const html = renderDashboardHtml(collectDashboard(db, reachCfg));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(String(err.message || err));
    } finally {
      db.close();
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, url: `http://${host}:${actualPort}`, port: actualPort });
    });
  });
}
