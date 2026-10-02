import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { load } from "js-yaml";

// Timestamps in the schema are sqlite `datetime` text: 'YYYY-MM-DD HH:MM:SS'
// in UTC. Every helper here normalizes to that shape so injected `now` values
// (ISO strings, Date objects) compare correctly against stored columns.
const SQLITE_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function toSqliteTs(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace("T", " ");
  const s = String(value).trim();
  if (SQLITE_TS.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

// R3-9 is a UTC-day rule, not a rolling-24h rule: never DM and email the same
// person on the same UTC date.
export function utcDate(value) {
  const ts = toSqliteTs(value ?? new Date());
  return ts ? ts.slice(0, 10) : null;
}

export function shiftSqliteTs(value, days) {
  const ts = toSqliteTs(value ?? new Date());
  const d = new Date(`${ts.replace(" ", "T")}Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toSqliteTs(d);
}

// `candidate.*` lives in the profile yaml next to the `reach:` block. Reach
// never writes it, so a missing or unreadable profile yields no facts rather
// than an error — drafts then simply ground against less text.
export function loadCandidateFacts(reachCfg) {
  let raw;
  try {
    raw = load(readFileSync(reachCfg.profileFile, "utf8")) ?? {};
  } catch {
    return {};
  }
  const c = raw.candidate;
  return c && typeof c === "object" && !Array.isArray(c) ? c : {};
}

// Tailored resumes are usually PDFs. Only plain-text variants contribute
// grounding text; a binary decodes to U+FFFD and is skipped rather than fed to
// the checker as noise.
function readResumeText(reachCfg, asset) {
  if (!asset?.path) return "";
  const p = isAbsolute(asset.path) ? asset.path : join(reachCfg.paths.dataDir, asset.path);
  let text;
  try {
    text = readFileSync(p).toString("utf8");
  } catch {
    return "";
  }
  return text.includes("\uFFFD") ? "" : text;
}

function textOf(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

// PRD §11/§12: suppression beats every other rule, so it is checked before any
// eligibility question. M1 owns the CLI side; this stays local so the outreach
// path never depends on that branch landing first.
export function isSuppressed(db, person) {
  if (!person) return false;
  if (person.do_not_contact) return true;
  if (person.lifecycle === "suppressed") return true;
  const suppressionHit = db.prepare("SELECT 1 FROM suppression WHERE kind = ? AND value = ?");
  if (person.linkedin_url && suppressionHit.get("linkedin_url", person.linkedin_url)) return true;
  for (const row of db.prepare("SELECT email FROM email_address WHERE person_id = ?").all(person.id)) {
    if (suppressionHit.get("email", row.email)) return true;
  }
  const company = person.company_id
    ? db.prepare("SELECT domain FROM company WHERE id = ?").get(person.company_id)
    : null;
  if (company?.domain) {
    const domain = String(company.domain).toLowerCase().replace(/^www\./, "");
    for (const row of db.prepare("SELECT value FROM suppression WHERE kind = 'domain'").all()) {
      const v = String(row.value).toLowerCase().replace(/^www\./, "");
      if (v && (domain === v || domain.endsWith(`.${v}`))) return true;
    }
  }
  return false;
}

export function loadPerson(db, personId) {
  return db.prepare("SELECT * FROM person WHERE id = ?").get(personId) ?? null;
}

// The only text a draft is allowed to assert. `headline` is deliberately
// absent: it is untrusted profile text, so grounding against it would let an
// injected instruction validate itself. It is quoted and handed to the model as
// data instead (see grounding.mjs / draft.mjs).
export function loadFactPack(db, reachCfg, personId) {
  const person = loadPerson(db, personId);
  if (!person) throw new Error(`loadFactPack: no person ${personId}`);
  const company = person.company_id
    ? db.prepare("SELECT * FROM company WHERE id = ?").get(person.company_id) ?? null
    : null;
  const target = db.prepare(
    "SELECT t.* FROM target_role t JOIN person_target pt ON pt.target_id = t.id"
    + " WHERE pt.person_id = ? ORDER BY t.id LIMIT 1",
  ).get(personId) ?? null;
  const candidate = loadCandidateFacts(reachCfg);
  const resumeAsset = target
    ? db.prepare("SELECT * FROM resume_asset WHERE job_ref = ? ORDER BY id DESC LIMIT 1")
      .get(target.job_ref) ?? null
    : null;
  const resumeText = readResumeText(reachCfg, resumeAsset);

  const candidateLines = Object.entries(candidate)
    .map(([k, v]) => `${k}: ${textOf(v)}`)
    .filter((line) => !line.endsWith(": "));

  const sources = [
    person.full_name,
    person.title,
    company?.name,
    company?.domain,
    target?.title,
    target?.job_ref,
    resumeAsset?.path,
    ...candidateLines,
    resumeText,
  ].map(textOf).filter(Boolean);

  return {
    person,
    company: company ?? null,
    target: target ?? null,
    candidate,
    resumeText,
    resumeAsset: resumeAsset ?? null,
    sources,
  };
}

export function sourcesText(factPack) {
  const list = Array.isArray(factPack) ? factPack : (factPack?.sources ?? []);
  return list.filter(Boolean).join("\n");
}

// R3-1: one LinkedIn out-message per accepted connection, ever. A cancelled
// draft does not consume the touch.
export function needsLinkedinDraft(db, personId) {
  const person = loadPerson(db, personId);
  if (!person) return false;
  if (isSuppressed(db, person)) return false;
  const conn = db.prepare("SELECT status FROM connection WHERE person_id = ?").get(personId);
  if (conn?.status !== "accepted") return false;
  const prior = db.prepare(
    "SELECT 1 FROM message WHERE person_id = ? AND channel = 'linkedin' AND direction = 'out'"
    + " AND status <> 'cancelled' LIMIT 1",
  ).get(personId);
  return !prior;
}

function primaryVerifiedEmail(db, personId, requireVerified) {
  const rows = db.prepare(
    "SELECT email, verification, is_primary FROM email_address WHERE person_id = ?"
    + " ORDER BY is_primary DESC, id ASC",
  ).all(personId);
  if (!rows.length) return null;
  if (!requireVerified) return rows[0];
  // v1 sends to `valid` only. `accept_all` domain catch-alls and `risky`
  // pattern guesses are deliberately not good enough.
  return rows.find((r) => r.verification === "valid") ?? null;
}

export function hasInboundReply(db, personId) {
  return Boolean(db.prepare(
    "SELECT 1 FROM message WHERE person_id = ? AND direction = 'in' LIMIT 1",
  ).get(personId));
}

function linkedinSentAt(db, personId) {
  return db.prepare(
    "SELECT sent_at FROM message WHERE person_id = ? AND channel = 'linkedin'"
    + " AND direction = 'out' AND status = 'sent' AND sent_at IS NOT NULL"
    + " ORDER BY sent_at DESC LIMIT 1",
  ).get(personId)?.sent_at ?? null;
}

// R3-2/R3-6: first email waits `delayDays` after the LinkedIn touch; step 2 waits
// `followupDays` after the first email. Then stop — no third touch.
export function needsEmailDraft(db, personId, {
  delayDays = 2, followupDays = 7, requireVerified = true, now = new Date(), step = 1,
} = {}) {
  const person = loadPerson(db, personId);
  if (!person) return false;
  if (isSuppressed(db, person)) return false;
  if (hasInboundReply(db, personId)) return false;
  if (!primaryVerifiedEmail(db, personId, requireVerified)) return false;

  if (step === 2) {
    const first = db.prepare(
      "SELECT sent_at FROM message WHERE person_id = ? AND channel = 'email' AND direction = 'out'"
      + " AND step = 1 AND status = 'sent' AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1",
    ).get(personId);
    if (!first) return false;
    return toSqliteTs(now) >= shiftSqliteTs(first.sent_at, followupDays);
  }

  const prior = db.prepare(
    "SELECT 1 FROM message WHERE person_id = ? AND channel = 'email' AND direction = 'out'"
    + " AND status <> 'cancelled' LIMIT 1",
  ).get(personId);
  if (prior) return false;

  const liSentAt = linkedinSentAt(db, personId);
  if (!liSentAt) return false;
  if (utcDate(liSentAt) === utcDate(now)) return false; // R3-9
  return toSqliteTs(now) >= shiftSqliteTs(liSentAt, delayDays);
}
