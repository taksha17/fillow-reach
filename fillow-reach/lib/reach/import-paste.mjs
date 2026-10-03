import { upsertCompany, upsertPerson, isSuppressed } from "./people.mjs";
import { recordEvent } from "./db.mjs";

const LINKEDIN_IN_RE = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i;
const DASH_SEP = /\s+[—–]\s+|\s+-\s+/;

function looksLikeName(line) {
  return /[A-Za-z]/.test(line) && line.length >= 2 && line.length <= 60;
}

function splitTitleCompany(rest) {
  const m = rest.match(/^(.+?)\s+at\s+(.+)$/i);
  return m ? { title: m[1].trim(), company: m[2].trim() } : { title: rest.trim(), company: null };
}

function findUrl(blockLines) {
  for (const line of blockLines) {
    const m = line.match(LINKEDIN_IN_RE);
    if (m) return m[0];
  }
  return undefined;
}

// Paste formats (PRD R1-8): `Name — Title at Company` one-liners and
// Name / Title at Company / linkedin.com/in/... blocks. A block only yields a
// row when it carries a name AND a title/company line — anything else the user
// copied (nav text, "About", company-page noise) is skipped.
export function parsePaste(text) {
  const rows = [];
  const blocks = String(text ?? "").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const url = findUrl(lines);
    // URLs may sit inline; strip them out of the text before pattern matching.
    const bare = lines.map((l) => l.replace(new RegExp(LINKEDIN_IN_RE.source, "gi"), "").trim()).filter(Boolean);

    // single-line `Name — Title at Company`
    const dashLine = bare.find((l) => DASH_SEP.test(l) && looksLikeName(l.split(DASH_SEP)[0]));
    if (dashLine) {
      const [name, rest] = dashLine.split(DASH_SEP);
      const cleaned = { full_name: name.trim(), ...splitTitleCompany(rest) };
      if (cleaned.title && looksLikeName(cleaned.full_name)) rows.push({ ...cleaned, ...(url ? { linkedin_url: url } : {}) });
      continue;
    }

    // multi-line Name / Title at Company / url
    const titleLine = bare.find((l) => /\s+at\s+/i.test(l));
    if (!titleLine) continue;
    const nameLine = bare.find((l) => l !== titleLine && looksLikeName(l));
    if (!nameLine) continue;
    const row = { full_name: nameLine, ...splitTitleCompany(titleLine), ...(url ? { linkedin_url: url } : {}) };
    rows.push(row);
  }
  return rows;
}

export function personaFromTitle(title) {
  const t = String(title ?? "").toLowerCase();
  if (/recruit|talent|sourcer/.test(t)) return "recruiter";
  if (/hiring manager/.test(t)) return "hiring_manager";
  if (/engineer|scientist|designer/.test(t)) return "senior_ic";
  return "other";
}

export function importPaste(db, text, { apply = false, source = "paste_import", agent = "prospect" } = {}) {
  const parsedRows = parsePaste(text);
  let imported = 0;
  let skipped = 0;
  if (apply) {
    for (const row of parsedRows) {
      if (!row.full_name) { skipped += 1; continue; }
      if (isSuppressed(db, { linkedin_url: row.linkedin_url })) { skipped += 1; continue; }
      const companyId = row.company ? upsertCompany(db, { name: row.company }) : null;
      const res = upsertPerson(db, {
        full_name: row.full_name,
        title: row.title,
        companyId,
        linkedin_url: row.linkedin_url,
        persona: personaFromTitle(row.title),
        source,
        agent,
      });
      if (res) imported += 1; else skipped += 1;
    }
    recordEvent(db, { agent, entity: "person", action: "paste_imported", detail: { parsed: parsedRows.length, imported, skipped, source } });
  }
  return { parsed: parsedRows.length, imported, skipped, preview: parsedRows };
}
