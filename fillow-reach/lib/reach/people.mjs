// M1-plan Task 1 helper contracts (people upsert + suppression gate), scoped
// to what M2 prospecting consumes: upsertCompany / upsertPerson / isSuppressed
// / addSuppression + normalizers. insertEmailAddress and forgetPerson remain
// M1's to deliver; `email` here is dedup-lookup only.
import { recordEvent } from "./db.mjs";

export function normalizeLinkedinUrl(url) {
  if (!url || typeof url !== "string") return null;
  let u = url.trim().toLowerCase();
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  u = u.split("?")[0].split("#")[0];
  u = u.replace(/\/+$/, "");
  return u === "" ? null : u;
}

export function normalizeCompanyName(name) {
  let n = String(name ?? "").toLowerCase().replace(/[^\sa-z0-9]/g, " ");
  n = n.replace(/\s+/g, " ").trim();
  n = n.replace(/\s+(inc|llc|ltd|corp|co)$/i, "");
  return n.trim();
}

export function normalizePersonName(name) {
  return String(name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function upsertCompany(db, { name, domain = null, linkedin_url = null, ats_source = null } = {}) {
  const nameNorm = normalizeCompanyName(name);
  if (!nameNorm) throw new Error("upsertCompany: name is required");
  const existing = db.prepare("SELECT id FROM company WHERE name_norm=?").get(nameNorm);
  if (existing) {
    db.prepare(
      "UPDATE company SET domain=COALESCE(?, domain), linkedin_url=COALESCE(?, linkedin_url), ats_source=COALESCE(?, ats_source) WHERE id=?"
    ).run(domain, linkedin_url, ats_source, existing.id);
    return existing.id;
  }
  const r = db.prepare(
    "INSERT INTO company (name, name_norm, domain, linkedin_url, ats_source) VALUES (?,?,?,?,?)"
  ).run(String(name), nameNorm, domain, linkedin_url, ats_source);
  return Number(r.lastInsertRowid);
}

export function isSuppressed(db, { email, linkedin_url, domain } = {}) {
  const checks = [
    ["email", typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null],
    ["linkedin_url", normalizeLinkedinUrl(linkedin_url)],
    ["domain", typeof domain === "string" && domain.trim() ? domain.trim().toLowerCase() : null],
  ];
  for (const [kind, value] of checks) {
    if (!value) continue;
    if (db.prepare("SELECT 1 FROM suppression WHERE kind=? AND value=?").get(kind, value)) return true;
  }
  return false;
}

export function addSuppression(db, { kind, value, reason, agent = "contacts" } = {}) {
  const normalized = kind === "linkedin_url"
    ? normalizeLinkedinUrl(value)
    : String(value ?? "").trim().toLowerCase();
  if (!normalized) throw new Error(`addSuppression: cannot normalize ${kind} value`);
  const r = db.prepare("INSERT OR IGNORE INTO suppression (kind, value, reason) VALUES (?,?,?)").run(kind, normalized, reason);
  recordEvent(db, { agent, entity: "person", action: "suppressed", detail: { kind, value: normalized, reason } });
  const row = db.prepare("SELECT id FROM suppression WHERE kind=? AND value=?").get(kind, normalized);
  return row.id;
}

function personCompanyDomain(db, companyId) {
  if (!companyId) return null;
  const row = db.prepare("SELECT domain FROM company WHERE id=?").get(companyId);
  return row?.domain ?? null;
}

export function upsertPerson(db, {
  full_name, headline = null, title = null, companyId = null, linkedin_url = null,
  location = null, persona = "other", source, relevance_score = null, relevance_reasons = null,
  email = null, agent = "contacts",
} = {}) {
  const name = String(full_name ?? "").trim();
  if (!name) throw new Error("upsertPerson: full_name is required");
  const url = normalizeLinkedinUrl(linkedin_url);
  const emailNorm = typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;

  if (isSuppressed(db, { email: emailNorm, linkedin_url: url, domain: personCompanyDomain(db, companyId) })) {
    recordEvent(db, { agent, entity: "person", action: "suppressed_blocked", detail: { linkedin_url: url, email: emailNorm } });
    return null;
  }

  // Dedup order (PRD R1-3): normalized LinkedIn URL, then email, then fuzzy name+company.
  let existing = null;
  if (url) existing = db.prepare("SELECT id FROM person WHERE linkedin_url=?").get(url);
  if (!existing && emailNorm) {
    const row = db.prepare("SELECT person_id FROM email_address WHERE email=?").get(emailNorm);
    if (row) existing = db.prepare("SELECT id FROM person WHERE id=?").get(row.person_id);
  }
  if (!existing) {
    const norm = normalizePersonName(name);
    const candidates = db.prepare("SELECT id, company_id, full_name FROM person").all();
    for (const c of candidates) {
      if (normalizePersonName(c.full_name) === norm
          && (c.company_id ?? null) === (companyId ?? null)) {
        existing = { id: c.id };
        break;
      }
    }
  }

  if (existing) {
    db.prepare(
      "UPDATE person SET headline=COALESCE(?, headline), title=COALESCE(?, title), location=COALESCE(?, location), updated_at=datetime('now') WHERE id=?"
    ).run(headline, title, location, existing.id);
    recordEvent(db, { agent, entity: "person", entityId: existing.id, action: "person_upserted", detail: { created: false } });
    return { personId: existing.id, created: false };
  }

  const spaceAt = name.indexOf(" ");
  const first = spaceAt === -1 ? name : name.slice(0, spaceAt);
  const last = spaceAt === -1 ? null : name.slice(spaceAt + 1);
  const r = db.prepare(
    `INSERT INTO person (full_name, first_name, last_name, headline, title, company_id, linkedin_url,
     location, persona, source, relevance_score, relevance_reasons, lifecycle)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'prospect')`
  ).run(name, first, last, headline, title, companyId ?? null, url, location, persona, source, relevance_score, relevance_reasons);
  const personId = Number(r.lastInsertRowid);
  recordEvent(db, { agent, entity: "person", entityId: personId, action: "person_upserted", detail: { created: true } });
  return { personId, created: true };
}
