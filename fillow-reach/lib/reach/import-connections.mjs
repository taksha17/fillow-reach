import { recordEvent } from "./db.mjs";
import { upsertCompany, upsertPerson, insertEmailAddress } from "./people.mjs";

const HEADER_ALIASES = {
  first: ["first name", "first"],
  last: ["last name", "last"],
  company: ["company", "company name"],
  title: ["position", "title"],
  linkedin_url: ["url", "linkedin url", "profile url"],
  email: ["email address", "email"],
};

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function mapHeader(name) {
  const key = String(name || "").replace(/^\uFEFF/, "").trim().toLowerCase();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(key)) return field;
  }
  return null;
}

export function parseConnectionsCsv(csvText) {
  const text = String(csvText || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n").filter((l) => l.trim().length);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map(mapHeader);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const rec = { first: "", last: "", full_name: "", company: "", title: "", linkedin_url: "", email: "" };
    headers.forEach((h, i) => { if (h) rec[h] = (cells[i] ?? "").trim(); });
    rec.full_name = rec.full_name || [rec.first, rec.last].filter(Boolean).join(" ").trim();
    if (!rec.full_name) continue;
    rows.push(rec);
  }
  return rows;
}

function personaFromTitle(title) {
  return /recruit|talent|sourcer/i.test(title || "") ? "recruiter" : "other";
}

export function importConnectionsCsv(db, csvText, { apply = false, source = "csv_import" } = {}) {
  const parsedRows = parseConnectionsCsv(csvText);
  const preview = parsedRows.slice(0, 20);
  const result = { parsed: parsedRows.length, imported: 0, skipped: 0, preview };
  if (!apply) return result;
  for (const row of parsedRows) {
    const companyId = row.company ? upsertCompany(db, { name: row.company }) : null;
    const person = upsertPerson(db, {
      full_name: row.full_name,
      title: row.title || null,
      companyId,
      linkedin_url: row.linkedin_url || null,
      persona: personaFromTitle(row.title),
      source,
      email: row.email || null,
    });
    if (!person) { result.skipped += 1; continue; }
    db.prepare(
      `INSERT INTO connection (person_id, status, accepted_via)
       VALUES (?, 'already_connected', 'csv_import')
       ON CONFLICT(person_id) DO UPDATE SET status = 'already_connected', accepted_via = 'csv_import'`,
    ).run(person.personId);
    db.prepare("UPDATE person SET lifecycle = 'connected', updated_at = datetime('now') WHERE id = ?").run(person.personId);
    if (row.email) insertEmailAddress(db, { person_id: person.personId, email: row.email, source: "manual" });
    result.imported += 1;
  }
  recordEvent(db, { agent: "contacts", entity: "system", action: "csv_imported", detail: { parsed: result.parsed, imported: result.imported, skipped: result.skipped } });
  return result;
}
