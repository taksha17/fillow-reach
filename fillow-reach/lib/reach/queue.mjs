import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { checkCap } from "./caps.mjs";
import { recordEvent } from "./db.mjs";
import { isSuppressed, normalizeCompanyName } from "./people.mjs";
import { scorePerson } from "./score.mjs";

const BLOCKING_STATUSES = new Set(["queued", "sent", "accepted", "already_connected"]);

function loadBlacklistNames(dataDir) {
  const file = join(dataDir, "blacklist.md");
  if (!existsSync(file)) return new Set();
  const names = new Set();
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/^[-*]\s*/, "").trim();
    if (!line || line.startsWith("#")) continue;
    names.add(normalizeCompanyName(line));
  }
  return names;
}

function targetRoleFor(db, companyId) {
  if (!companyId) return null;
  return db.prepare("SELECT id, title FROM target_role WHERE company_id=? ORDER BY id LIMIT 1").get(companyId) ?? null;
}

function companyIsTarget(db, companyId) {
  if (!companyId) return false;
  return Boolean(db.prepare("SELECT 1 FROM target_role WHERE company_id=? LIMIT 1").get(companyId));
}

function daysSince(sqlTs, nowMs) {
  if (!sqlTs) return null;
  const then = Date.parse(`${sqlTs.replace(" ", "T")}Z`);
  if (Number.isNaN(then)) return null;
  return (nowMs - then) / 86400000;
}

// R1-4 skip: any prior invite still inside the 90-day window, regardless of the
// connection's current status.
function inviteWithin90Days(db, personId) {
  return Boolean(db.prepare(
    "SELECT 1 FROM connection WHERE person_id=? AND sent_at IS NOT NULL AND sent_at >= datetime('now','-90 days')"
  ).get(personId));
}

function blockingConnection(db, personId) {
  const row = db.prepare("SELECT status FROM connection WHERE person_id=?").get(personId);
  return row ? BLOCKING_STATUSES.has(row.status) : false;
}

export function queueDaily(db, reachCfg, { now = null, agent = "prospect" } = {}) {
  const nowMs = now != null ? new Date(now).getTime() : Date.now();
  const blacklist = loadBlacklistNames(reachCfg.paths.dataDir);
  const min = reachCfg.minRelevance;
  const personas = reachCfg.personas;

  const considered = [];
  for (const p of db.prepare(
    "SELECT id, full_name, title, persona, company_id, linkedin_url, created_at FROM person WHERE lifecycle='prospect' AND do_not_contact=0 ORDER BY id"
  ).all()) {
    if (!personas.includes(p.persona)) continue;

    if (blockingConnection(db, p.id) || inviteWithin90Days(db, p.id)) continue;
    if (isSuppressed(db, { linkedin_url: p.linkedin_url })) continue;
    const company = p.company_id
      ? db.prepare("SELECT name_norm, blacklisted, domain FROM company WHERE id=?").get(p.company_id)
      : null;
    if (company && (company.blacklisted === 1 || blacklist.has(company.name_norm))) continue;
    if (isSuppressed(db, { domain: company?.domain ?? null })) continue;

    const target = targetRoleFor(db, p.company_id);
    const { score, reasons } = scorePerson({
      title: p.title,
      persona: p.persona,
      companyIsTarget: companyIsTarget(db, p.company_id),
      recencyDays: daysSince(p.created_at, nowMs),
      targetTitle: target?.title ?? null,
      personas,
    });
    if (score < min) continue;
    considered.push({ ...p, score, reasons });
  }

  considered.sort((a, b) => b.score - a.score || a.id - b.id);

  // Queue slots: the daily queue itself is capped (R1-5), and queueing consumes
  // 7-day headroom alongside the sent-window caps checkCap enforces.
  let daySlots = reachCfg.limits.invitesPerDay
    - db.prepare("SELECT COUNT(*) AS n FROM connection WHERE queued_at >= datetime('now','-1 day')").get().n;
  let weekSlots = reachCfg.limits.invitesPer7d
    - db.prepare("SELECT COUNT(*) AS n FROM connection WHERE COALESCE(sent_at, queued_at) >= datetime('now','-7 days')").get().n;

  let queued = 0;
  for (const cand of considered) {
    if (daySlots <= 0 || weekSlots <= 0) break; // rest stay prospect, never failed
    const cap = checkCap({ db, reachCfg, action: "invite" });
    if (!cap.ok) break;
    if (now != null) {
      db.prepare(
        "INSERT INTO connection (person_id, status, queued_at) VALUES (?, 'queued', ?) ON CONFLICT(person_id) DO UPDATE SET status='queued', queued_at=?"
      ).run(cand.id, now, now);
    } else {
      db.prepare(
        "INSERT INTO connection (person_id, status, queued_at) VALUES (?, 'queued', datetime('now')) ON CONFLICT(person_id) DO UPDATE SET status='queued', queued_at=datetime('now')"
      ).run(cand.id);
    }
    db.prepare("UPDATE person SET relevance_score=?, relevance_reasons=?, updated_at=datetime('now') WHERE id=?")
      .run(cand.score, JSON.stringify(cand.reasons), cand.id);
    const target = targetRoleFor(db, cand.company_id);
    if (target) {
      db.prepare("INSERT OR IGNORE INTO person_target (person_id, target_id, reason) VALUES (?,?,?)")
        .run(cand.id, target.id, cand.reasons[0] ?? null);
    }
    recordEvent(db, { agent, entity: "connection", entityId: cand.id, action: "invite_queued", detail: { score: cand.score, reasons: cand.reasons } });
    daySlots -= 1;
    weekSlots -= 1;
    queued += 1;
  }

  return { considered: considered.length, queued, skipped: considered.length - queued };
}
