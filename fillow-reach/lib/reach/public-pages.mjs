import { upsertCompany, upsertPerson } from "./people.mjs";
import { recordEvent } from "./db.mjs";
import { personaFromTitle } from "./import-paste.mjs";

// Public team/about pages (PRD R1-9): plain fetch, no login, no fingerprint
// spoofing, robots.txt honored, blocked pages skipped — never fatal to a batch.
const LINKEDIN_IN_RE = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i;

function looksLikeName(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!/^[A-Z]/.test(t) || t.length < 2 || t.length > 60) return false;
  const words = t.split(" ");
  if (words.length > 5) return false;
  return words.length >= 2 || t.length >= 4;
}

export function robotsAllows(robotsTxt, path) {
  const lines = String(robotsTxt ?? "").split(/\r?\n/);
  let inStar = false;
  const disallow = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, key, value] = m;
    if (key.toLowerCase() === "user-agent") {
      inStar = value.trim() === "*";
      continue;
    }
    if (key.toLowerCase() === "disallow" && inStar) disallow.push(value.trim());
  }
  for (const rule of disallow) {
    if (rule === "") continue; // `Disallow:` with no value = allow everything
    if (String(path).startsWith(rule)) return false;
  }
  return true;
}

export function extractPeople(html, { company } = {}) {
  const rows = [];
  const anchorRe = /<a\b[^>]*href="([^"]*linkedin\.com\/in\/[A-Za-z0-9_-]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of String(html ?? "").matchAll(anchorRe)) {
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const dash = text.split(/\s+[—–]\s+/);
    let name = null;
    let title = null;
    if (dash.length >= 2 && looksLikeName(dash[0])) {
      name = dash[0];
      title = dash[1];
    } else if (looksLikeName(text)) {
      name = text;
    }
    if (name) rows.push({ full_name: name, title, linkedin_url: m[1], company });
  }

  const names = [...String(html).matchAll(/itemprop="name"[^>]*>\s*([^<]{2,60}?)\s*</g)].map((m) => m[1].trim());
  const titles = [...String(html).matchAll(/itemprop="jobTitle"[^>]*>\s*([^<]+?)\s*</g)].map((m) => m[1].trim());
  const urls = [...String(html).matchAll(new RegExp(LINKEDIN_IN_RE.source, "gi"))].map((m) => m[0]);
  if (names.length && names.length === titles.length && (!urls.length || urls.length === names.length)) {
    names.forEach((n, i) => {
      if (looksLikeName(n) && !rows.some((r) => r.full_name === n)) {
        rows.push({ full_name: n, title: titles[i], linkedin_url: urls[i] ?? null, company });
      }
    });
  }
  return rows;
}

// `detail` is the specific cause for the event log; `reason` is the pinned
// caller-facing bucket (PRD plan: blocked | not_found).
function skipped(db, url, detail, reason, agent) {
  recordEvent(db, { agent, entity: "person", action: "public_page_skipped", detail: { url, reason: detail } });
  return { imported: 0, skipped: 1, reason };
}

export async function importPublicPage(db, url, { fetchImpl = globalThis.fetch, apply = true, agent = "prospect" } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return skipped(db, url, "invalid_url", "invalid_url", agent);
  }

  // robots.txt unreachable (fetch throw or error status) means "no rules" = allow.
  try {
    const robots = await fetchImpl(`${u.origin}/robots.txt`);
    if (robots.ok && !robotsAllows(await robots.text(), u.pathname)) {
      return skipped(db, url, "robots", "blocked", agent);
    }
  } catch { /* allow */ }

  let page;
  try {
    page = await fetchImpl(url);
  } catch {
    return skipped(db, url, "fetch_error", "error", agent);
  }
  if (page.status === 403 || page.status === 401) return skipped(db, url, "http_403", "blocked", agent);
  if (page.status === 404) return skipped(db, url, "not_found", "not_found", agent);
  if (!page.ok) return skipped(db, url, `http_${page.status}`, "error", agent);

  const hostCompany = u.hostname.replace(/^www\./, "");
  const rows = extractPeople(await page.text(), { company: hostCompany });
  if (!apply) return { imported: 0, skipped: 0, reason: null, preview: rows };

  let imported = 0;
  let skippedCount = 0;
  const companyId = rows.length ? upsertCompany(db, { name: hostCompany }) : null;
  for (const row of rows) {
    const res = upsertPerson(db, {
      full_name: row.full_name,
      title: row.title,
      companyId,
      linkedin_url: row.linkedin_url,
      persona: personaFromTitle(row.title),
      source: "public_page",
      agent,
    });
    if (res) imported += 1; else skippedCount += 1;
  }
  return { imported, skipped: skippedCount, reason: null };
}
