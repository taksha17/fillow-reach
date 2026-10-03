import { recordEvent } from "./db.mjs";

const SUFFIX = /\b(inc|llc|ltd|corp|co)\.?$/i;

export function normalizeLinkedinUrl(url) {
  if (url == null) return null;
  let s = String(url).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.replace(/\?.*$/, "").replace(/\/+$/, "");
  return s || null;
}

export function normalizeCompanyName(name) {
  let s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  s = s.replace(SUFFIX, "").trim();
  return s;
}

export function normalizePersonName(name) {
  return String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function splitName(full) {
  const t = String(full || "").trim();
  const i = t.indexOf(" ");
  if (i < 0) return { first: t || null, last: null };
  return { first: t.slice(0, i), last: t.slice(i + 1).trim() || null };
}

function emailDomain(email) {
  const s = String(email || "").toLowerCase().trim();
  const at = s.lastIndexOf("@");
  return at >= 0 ? s.slice(at + 1) : null;
}

export function isSuppressed(db, { email, linkedin_url, domain } = {}) {
  const checks = [];
  if (email) checks.push(["email", String(email).toLowerCase().trim()]);
  const url = normalizeLinkedinUrl(linkedin_url);
  if (url) checks.push(["linkedin_url", url]);
  if (domain) checks.push(["domain", String(domain).toLowerCase().trim()]);
  const ed = emailDomain(email);
  if (ed) checks.push(["domain", ed]);
  for (const [kind, value] of checks) {
    const row = db.prepare("SELECT 1 FROM suppression WHERE kind = ? AND value = ?").get(kind, value);
    if (row) return true;
  }
  return false;
}

export function addSuppression(db, { kind, value, reason }) {
  let v = String(value || "").trim();
  if (kind === "email") v = v.toLowerCase();
  else if (kind === "linkedin_url") v = normalizeLinkedinUrl(v) || v.toLowerCase();
  else if (kind === "domain") v = v.toLowerCase();
  const r = db.prepare(
    "INSERT INTO suppression (kind, value, reason) VALUES (?, ?, ?) ON CONFLICT(kind, value) DO UPDATE SET reason = excluded.reason",
  ).run(kind, v, reason);
  const id = r.lastInsertRowid || db.prepare("SELECT id FROM suppression WHERE kind = ? AND value = ?").get(kind, v).id;
  recordEvent(db, { agent: "contacts", entity: "system", action: "suppressed", detail: { kind, value: v, reason } });
  return id;
}

export function upsertCompany(db, { name, domain = null, linkedin_url = null, ats_source = null } = {}) {
  const name_norm = normalizeCompanyName(name);
  const existing = db.prepare("SELECT id FROM company WHERE name_norm = ?").get(name_norm);
  if (existing) {
    if (domain || linkedin_url || ats_source) {
      db.prepare(
        "UPDATE company SET domain = COALESCE(?, domain), linkedin_url = COALESCE(?, linkedin_url), ats_source = COALESCE(?, ats_source) WHERE id = ?",
      ).run(domain ?? null, linkedin_url ?? null, ats_source ?? null, existing.id);
    }
    return existing.id;
  }
  const r = db.prepare(
    "INSERT INTO company (name, name_norm, domain, linkedin_url, ats_source) VALUES (?, ?, ?, ?, ?)",
  ).run(name, name_norm, domain ?? null, linkedin_url ?? null, ats_source ?? null);
  return r.lastInsertRowid;
}

function findPerson(db, { linkedin_url, email, full_name, companyId }) {
  const url = normalizeLinkedinUrl(linkedin_url);
  if (url) {
    const byUrl = db.prepare("SELECT id FROM person WHERE linkedin_url = ?").get(url);
    if (byUrl) return byUrl.id;
  }
  if (email) {
    const byEmail = db.prepare("SELECT person_id AS id FROM email_address WHERE email = ?").get(String(email).toLowerCase().trim());
    if (byEmail) return byEmail.id;
  }
  if (full_name && companyId != null) {
    const n = normalizePersonName(full_name);
    const rows = db.prepare("SELECT id, full_name FROM person WHERE company_id = ?").all(companyId);
    const hit = rows.find((p) => normalizePersonName(p.full_name) === n);
    if (hit) return hit.id;
  }
  return null;
}

export function upsertPerson(db, {
  full_name, headline = null, title = null, companyId = null, linkedin_url = null,
  location = null, persona = "other", source, relevance_score = null, relevance_reasons = null, email = null,
} = {}) {
  const url = normalizeLinkedinUrl(linkedin_url);
  let domain = null;
  if (companyId != null) {
    domain = db.prepare("SELECT domain FROM company WHERE id = ?").get(companyId)?.domain ?? null;
  }
  if (isSuppressed(db, { email, linkedin_url: url, domain })) {
    recordEvent(db, { agent: "contacts", entity: "person", action: "suppressed_blocked", detail: { full_name, url, email } });
    return null;
  }
  const existingId = findPerson(db, { linkedin_url: url, email, full_name, companyId });
  if (existingId) {
    recordEvent(db, { agent: "contacts", entity: "person", entityId: existingId, action: "person_upserted", detail: { created: false } });
    return { personId: existingId, created: false };
  }
  const { first, last } = splitName(full_name);
  const reasons = relevance_reasons == null ? null : (typeof relevance_reasons === "string" ? relevance_reasons : JSON.stringify(relevance_reasons));
  const r = db.prepare(
    `INSERT INTO person (full_name, first_name, last_name, headline, title, company_id, linkedin_url, location, persona, source, relevance_score, relevance_reasons)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(full_name, first, last, headline, title, companyId, url, location, persona, source, relevance_score, reasons);
  const personId = r.lastInsertRowid;
  recordEvent(db, { agent: "contacts", entity: "person", entityId: personId, action: "person_upserted", detail: { created: true } });
  if (email) insertEmailAddress(db, { person_id: personId, email, source: "manual" });
  return { personId, created: true };
}

export function insertEmailAddress(db, { person_id, email, source, confidence = null, verification = "unknown" } = {}) {
  const addr = String(email || "").toLowerCase().trim();
  const domain = emailDomain(addr);
  if (isSuppressed(db, { email: addr, domain })) {
    recordEvent(db, { agent: "contacts", entity: "email_address", action: "suppressed_blocked", entityId: person_id, detail: { email: addr } });
    return null;
  }
  const existing = db.prepare("SELECT id FROM email_address WHERE person_id = ? AND email = ?").get(person_id, addr);
  if (existing) {
    if (verification !== "unknown") {
      db.prepare("UPDATE email_address SET verification = ?, confidence = COALESCE(?, confidence), verified_at = datetime('now') WHERE id = ?")
        .run(verification, confidence, existing.id);
    }
    recordEvent(db, { agent: "contacts", entity: "email_address", entityId: existing.id, action: "email_stored", detail: { created: false } });
    return { id: existing.id, created: false };
  }
  const verifiedAt = verification !== "unknown" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null;
  const r = db.prepare(
    "INSERT INTO email_address (person_id, email, source, confidence, verification, verified_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(person_id, addr, source, confidence, verification, verifiedAt);
  recordEvent(db, { agent: "contacts", entity: "email_address", entityId: r.lastInsertRowid, action: "email_stored", detail: { created: true } });
  return { id: r.lastInsertRowid, created: true };
}

export function forgetPerson(db, personId) {
  const id = Number(personId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false };
  const row = db.prepare("SELECT id FROM person WHERE id = ?").get(id);
  if (!row) return { ok: false };
  recordEvent(db, { agent: "contacts", entity: "person", entityId: id, action: "person_forgotten", detail: { personId: id } });
  db.prepare("UPDATE event_log SET detail = '{\"redacted\":true}' WHERE entity = 'person' AND entity_id = ?").run(id);
  db.prepare("DELETE FROM person WHERE id = ?").run(id);
  return { ok: true };
}

export function purgeExpired(db, retentionDays) {
  const days = Number(retentionDays);
  const rows = db.prepare(
    `SELECT id FROM person
     WHERE lifecycle IN ('closed','suppressed')
       AND updated_at < datetime('now', '-' || ? || ' days')`,
  ).all(days);
  let purged = 0;
  for (const r of rows) {
    if (forgetPerson(db, r.id).ok) purged += 1;
  }
  return { purged };
}
