import { recordEvent, usageSnapshot } from "./db.mjs";
import { healthGuard } from "./caps.mjs";
import { isPaused } from "./killswitch.mjs";

const EMPTY_FUNNEL = Object.freeze({
  prospect: 0, invited: 0, connected: 0, messaged: 0, replied: 0, closed: 0, suppressed: 0,
});

export function funnelCounts(db) {
  const out = { ...EMPTY_FUNNEL };
  for (const row of db.prepare("SELECT lifecycle, COUNT(*) AS n FROM person GROUP BY lifecycle").all()) {
    if (row.lifecycle in out) out[row.lifecycle] = row.n;
  }
  return out;
}

export function todayQueue(db) {
  return db.prepare(
    `SELECT p.id AS person_id, p.full_name, p.title, c.name AS company,
            p.linkedin_url, p.relevance_score
     FROM connection conn
     JOIN person p ON p.id = conn.person_id
     LEFT JOIN company c ON c.id = p.company_id
     WHERE conn.status = 'queued'
     ORDER BY p.relevance_score DESC, p.id`,
  ).all();
}

export function approvalQueue(db) {
  return db.prepare(
    `SELECT m.id, m.person_id, p.full_name, m.channel, m.subject, m.body
     FROM message m
     JOIN person p ON p.id = m.person_id
     WHERE m.status = 'needs_approval'
     ORDER BY m.id`,
  ).all();
}

export function personTimeline(db, personId) {
  return db.prepare(
    "SELECT id, ts, agent, entity, entity_id, action, detail FROM event_log WHERE entity_id = ? ORDER BY id",
  ).all(personId);
}

export function peopleList(db) {
  return db.prepare(
    `SELECT p.id, p.full_name, p.title, p.lifecycle, c.name AS company
     FROM person p
     LEFT JOIN company c ON c.id = p.company_id
     ORDER BY p.id`,
  ).all();
}

export function errorList(db) {
  const runs = db.prepare(
    "SELECT id, agent, status, stats FROM run WHERE status = 'failed' ORDER BY id DESC",
  ).all();
  const events = db.prepare(
    "SELECT id, ts, action, detail FROM event_log WHERE action LIKE '%provider_error%' OR action = 'provider_error' ORDER BY id DESC",
  ).all();
  return [
    ...runs.map((r) => ({ kind: "run", ...r })),
    ...events.map((e) => ({ kind: "event", ...e })),
  ];
}

export function markInviteSent(db, personId) {
  const id = Number(personId);
  db.prepare(
    "UPDATE connection SET status = 'sent', sent_via = 'manual', sent_at = datetime('now') WHERE person_id = ?",
  ).run(id);
  db.prepare("UPDATE person SET lifecycle = 'invited', updated_at = datetime('now') WHERE id = ?").run(id);
  recordEvent(db, { agent: "report", entity: "connection", entityId: id, action: "invite_marked_sent", detail: {} });
}

export function collectDashboard(db, reachCfg) {
  return {
    funnel: funnelCounts(db),
    queue: todayQueue(db),
    approvals: approvalQueue(db),
    people: peopleList(db),
    usage: usageSnapshot(db),
    limits: reachCfg.limits,
    health: healthGuard(db, reachCfg),
    errors: errorList(db),
    paused: isPaused(reachCfg),
  };
}
