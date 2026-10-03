import { existsSync } from "node:fs";
import { basename } from "node:path";
import nodemailer from "nodemailer";

import { recordEvent, usageSnapshot } from "./db.mjs";
import { healthGuard } from "./caps.mjs";

export function reportDate(now, timeZone) {
  const d = now instanceof Date ? now : new Date(now);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

function rate(n, d) {
  if (!d) return null;
  return n / d;
}

function clip(s, n = 120) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n);
}

export function buildDailyReport(db, reachCfg, { date } = {}) {
  const day = date ?? reportDate(new Date(), reachCfg.report?.timezone);
  const snap = usageSnapshot(db);
  const health = healthGuard(db, reachCfg);
  const invitesSent14 = db.prepare(
    "SELECT COUNT(*) AS n FROM connection WHERE sent_at >= datetime('now','-14 days')",
  ).get().n;
  const outSent14 = db.prepare(
    "SELECT COUNT(*) AS n FROM message WHERE direction='out' AND status='sent' AND sent_at >= datetime('now','-14 days')",
  ).get().n;
  const in14 = db.prepare(
    "SELECT COUNT(*) AS n FROM message WHERE direction='in' AND created_at >= datetime('now','-14 days')",
  ).get().n;
  const errors = db.prepare(
    "SELECT COUNT(*) AS n FROM run WHERE status='failed'",
  ).get().n
    + db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action LIKE '%error%'").get().n;
  const queuedTomorrow = db.prepare("SELECT COUNT(*) AS n FROM connection WHERE status='queued'").get().n;
  const L = reachCfg.limits;
  const header = {
    date: day,
    invites: `${snap.day.invite}/${L.invitesPerDay}`,
    emails: `${snap.day.email}/${L.emailsPerDay}`,
    acceptance14d: health.acceptanceRate14d,
    replyRate14d: rate(in14, outSent14),
    bounce14d: health.bounceRate14d,
    errors,
    queuedTomorrow,
    invitesSent14,
  };

  const ids = db.prepare(
    `SELECT DISTINCT person_id FROM (
       SELECT person_id FROM connection WHERE date(sent_at) = ? OR date(accepted_at) = ?
       UNION
       SELECT person_id FROM message
         WHERE (date(sent_at) = ? AND direction='out')
            OR (date(created_at) = ? AND (direction='in' OR status='replied'))
     )`,
  ).all(day, day, day, day).map((r) => r.person_id);

  const rows = ids.map((personId) => {
    const p = db.prepare(
      `SELECT p.full_name, p.title, c.name AS company
       FROM person p LEFT JOIN company c ON c.id = p.company_id WHERE p.id = ?`,
    ).get(personId);
    const conn = db.prepare("SELECT status FROM connection WHERE person_id = ?").get(personId);
    const email = db.prepare(
      "SELECT email, verification FROM email_address WHERE person_id = ? ORDER BY id DESC LIMIT 1",
    ).get(personId);
    const lastOut = db.prepare(
      "SELECT body, resume_asset_id FROM message WHERE person_id = ? AND direction='out' ORDER BY id DESC LIMIT 1",
    ).get(personId);
    const inbound = db.prepare(
      "SELECT status, reply_class FROM message WHERE person_id = ? AND direction='in' ORDER BY id DESC LIMIT 1",
    ).get(personId);
    const resumeToday = db.prepare(
      `SELECT 1 AS ok FROM message
       WHERE person_id = ? AND resume_asset_id IS NOT NULL AND date(sent_at) = ? LIMIT 1`,
    ).get(personId, day);
    return {
      personId,
      name: p?.full_name ?? "",
      role: p?.title ?? "",
      company: p?.company ?? "",
      linkedinStatus: conn?.status ?? "none",
      email: email?.email ?? "",
      emailVerification: email?.verification ?? "unknown",
      preview: clip(lastOut?.body, 120),
      replyStatus: inbound?.reply_class ?? inbound?.status ?? (lastOut ? "none" : "none"),
      resumeSent: Boolean(resumeToday),
    };
  });

  const attachments = [];
  if (reachCfg.report?.attachResumes) {
    const assets = db.prepare(
      `SELECT DISTINCT r.path FROM resume_asset r
       JOIN message m ON m.resume_asset_id = r.id
       WHERE date(m.sent_at) = ?`,
    ).all(day);
    for (const a of assets) {
      if (existsSync(a.path)) attachments.push({ path: a.path, filename: basename(a.path) });
    }
  }

  return { header, rows, attachments, date: day };
}

export function renderReportText(built) {
  const h = built.header ?? {};
  const lines = [
    `fillow Reach — daily report ${h.date ?? ""}`,
    `invites ${h.invites} · emails ${h.emails}`,
    `acceptance 14d ${h.acceptance14d == null ? "n/a" : Math.round(h.acceptance14d * 100) + "%"} · bounce ${h.bounce14d == null ? "n/a" : ((h.bounce14d * 100).toFixed(1) + "%")} · replies ${h.replyRate14d == null ? "n/a" : Math.round(h.replyRate14d * 100) + "%"}`,
    `errors ${h.errors ?? 0} · queued ${h.queuedTomorrow ?? 0}`,
    "",
  ];
  for (const row of built.rows ?? []) {
    lines.push(
      `${row.name} — ${row.role} @ ${row.company} · LI ${row.linkedinStatus} · email ${row.emailVerification} · reply ${row.replyStatus} · resume ${row.resumeSent ? "yes" : "no"}`,
    );
    if (row.preview) lines.push(`  ${row.preview}`);
  }
  return lines.join("\n");
}

async function defaultSendMail(reachCfg, mail) {
  const user = reachCfg.mail?.user;
  const password = reachCfg.mail?.password;
  if (!user || !password) throw new Error("mail credentials missing");
  const tx = nodemailer.createTransport({
    host: reachCfg.mail.smtp?.host ?? "smtp.gmail.com",
    port: reachCfg.mail.smtp?.port ?? 465,
    secure: (reachCfg.mail.smtp?.port ?? 465) === 465,
    auth: { user, pass: password },
  });
  await tx.sendMail(mail);
}

export async function sendDailyReport(db, reachCfg, { sendMailImpl, now, dryRun } = {}) {
  const when = now ?? new Date();
  const date = reportDate(when, reachCfg.report?.timezone);
  const built = buildDailyReport(db, reachCfg, { date });
  const text = renderReportText(built);
  const dry = dryRun ?? reachCfg.dryRun;
  db.prepare("INSERT INTO report (report_date, status) VALUES (?, 'built') ON CONFLICT(report_date) DO UPDATE SET status = 'built'").run(date);
  if (dry) {
    recordEvent(db, { agent: "report", entity: "system", action: "report_sent", detail: { date, dryRun: true } });
    return { status: "built", date, rows: built.rows.length };
  }
  const mail = {
    from: reachCfg.mail?.user,
    to: reachCfg.mail?.user,
    subject: `fillow Reach daily report ${date}`,
    text,
    attachments: built.attachments,
  };
  const send = sendMailImpl ?? ((m) => defaultSendMail(reachCfg, m));
  await send(mail);
  db.prepare("UPDATE report SET status = 'sent', sent_at = datetime('now') WHERE report_date = ?").run(date);
  recordEvent(db, { agent: "report", entity: "system", action: "report_sent", detail: { date, dryRun: false } });
  return { status: "sent", date, rows: built.rows.length };
}
