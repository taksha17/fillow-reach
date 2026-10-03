import { recordEvent } from "./db.mjs";
import { addSuppression, isSuppressed, normalizeCompanyName, normalizePersonName } from "./people.mjs";

const NAME_RE = /([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+)+)\s+has accepted/;
const COMPANY_RE = /\bat\s+(.+?)(?:\.|$)/i;
const EMAIL_RE = /(?:Final-Recipient|Original-Recipient):[^\n;]*;?\s*(\S+@\S+)/i;

export function parseAcceptance(msg) {
  const subject = String(msg?.subject || "");
  const body = String(msg?.body || "");
  if (!/accepted your invitation/i.test(subject) && !/accepted your invitation/i.test(body)) return null;
  const m = subject.match(NAME_RE) || body.match(NAME_RE);
  if (!m) return null;
  const full_name = m[1].replace(/\s+/g, " ").trim();
  const around = (subject + "\n" + body).slice(Math.max(0, (subject.match(NAME_RE) ? 0 : subject.length)), 400);
  const c = around.match(COMPANY_RE);
  const company = c ? c[1].trim() : null;
  return { full_name, company };
}

export function parseBounce(msg) {
  const blob = `${msg?.subject || ""}\n${msg?.body || ""}`;
  const em = blob.match(EMAIL_RE);
  if (!em) return null;
  const email = em[1].replace(/[<>]/g, "").toLowerCase();
  const hard = /Status:\s*5\./i.test(blob) || /\b550\b/.test(blob) || /\b5\.\d\./.test(blob);
  const soft = /Status:\s*4\./i.test(blob) || /\b4\.\d\./.test(blob);
  if (hard && !/Status:\s*4\./i.test(blob)) return { email, class: "hard" };
  if (soft && !hard) return { email, class: "soft" };
  if (hard) return { email, class: "hard" };
  return null;
}

function loadMessages(fetcher) {
  if (typeof fetcher !== "function") throw new Error("detect*: fetcher is required");
  const got = fetcher();
  if (got && typeof got.then === "function") {
    throw new Error("fetcher must return messages synchronously in M1 unit tests; wrap IMAP in the contacts agent");
  }
  return got ?? [];
}

export function detectAcceptances(db, _reachCfg, { fetcher } = {}) {
  const messages = loadMessages(fetcher);
  const result = { checked: messages.length, accepted: 0, unmatched: 0 };
  for (const msg of messages) {
    const parsed = parseAcceptance(msg);
    if (!parsed) { result.unmatched += 1; continue; }
    const name = normalizePersonName(parsed.full_name);
    const people = db.prepare(
      `SELECT p.id, p.full_name, p.linkedin_url, c.name_norm, conn.status
       FROM person p
       LEFT JOIN company c ON c.id = p.company_id
       JOIN connection conn ON conn.person_id = p.id
       WHERE conn.status IN ('sent','queued','none')`,
    ).all().filter((p) => normalizePersonName(p.full_name) === name);
    const narrowed = parsed.company
      ? people.filter((p) => p.name_norm === normalizeCompanyName(parsed.company))
      : people;
    if (narrowed.length !== 1) {
      recordEvent(db, { agent: "contacts", entity: "person", action: "acceptance_unmatched", detail: { subject: msg.subject } });
      result.unmatched += 1;
      continue;
    }
    const hit = narrowed[0];
    if (isSuppressed(db, { linkedin_url: hit.linkedin_url })) {
      recordEvent(db, { agent: "contacts", entity: "person", entityId: hit.id, action: "suppressed_blocked", detail: { subject: msg.subject } });
      result.unmatched += 1;
      continue;
    }
    db.prepare(
      "UPDATE connection SET status = 'accepted', accepted_via = 'notification_email', accepted_at = datetime('now') WHERE person_id = ?",
    ).run(hit.id);
    db.prepare("UPDATE person SET lifecycle = 'connected', updated_at = datetime('now') WHERE id = ?").run(hit.id);
    recordEvent(db, { agent: "contacts", entity: "connection", entityId: hit.id, action: "invite_accepted", detail: {} });
    result.accepted += 1;
  }
  return result;
}

export function detectBounces(db, _reachCfg, { fetcher } = {}) {
  const messages = loadMessages(fetcher);
  const result = { checked: messages.length, hard: 0, soft: 0 };
  for (const msg of messages) {
    const parsed = parseBounce(msg);
    if (!parsed) continue;
    if (parsed.class === "soft") {
      recordEvent(db, { agent: "contacts", entity: "email_address", action: "bounce_soft", detail: { email: parsed.email } });
      result.soft += 1;
      continue;
    }
    db.prepare("UPDATE email_address SET verification = 'invalid', verified_at = datetime('now') WHERE email = ?").run(parsed.email);
    addSuppression(db, { kind: "email", value: parsed.email, reason: "bounce" });
    db.prepare(
      "UPDATE message SET status = 'bounced' WHERE channel = 'email' AND direction = 'out' AND person_id IN (SELECT person_id FROM email_address WHERE email = ?)",
    ).run(parsed.email);
    recordEvent(db, { agent: "contacts", entity: "email_address", action: "bounce_hard", detail: { email: parsed.email } });
    result.hard += 1;
  }
  return result;
}
