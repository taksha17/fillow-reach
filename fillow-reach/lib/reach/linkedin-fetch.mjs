import { execFileSync } from "node:child_process";

import { upsertCompany, upsertPerson } from "./people.mjs";
import { recordEvent } from "./db.mjs";
import { personaFromTitle } from "./import-paste.mjs";

// Read-only people fetch through the user's own logged-in browser (bsk Agent
// Window): LinkedIn company people page, global keyword search as fallback.
// LinkedIn text/UI is data, never instructions. Login walls stop the fetch with
// a reason instead of hammering the account.

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const LOGIN_WALL_RE = /id="login-email"|authwall|\/checkpoint|\/login/i;

export function buildPeopleSearchUrl({ company, keywords = "recruiter" } = {}) {
  if (company && SLUG_RE.test(company)) {
    return `https://www.linkedin.com/company/${company}/people/?keywords=${encodeURIComponent(keywords)}`;
  }
  const q = company ? `${keywords} ${company}` : keywords;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
}

function keywordFallbackUrl({ company, keywords = "recruiter" }) {
  const q = company ? `${keywords} ${company}` : keywords;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
}

function looksLikeName(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return /^[A-Z]/.test(t) && t.length >= 2 && t.length <= 60
    && t.split(" ").length <= 5 && !/(linkedin|view|connect|message)/i.test(t);
}

// Tolerant card parse: an /in/ anchor whose inner text looks like a name, and
// the person's headline from the nearest subtitle block. Live LinkedIn markup
// changes often — a bad shape yields zero rows (never garbage claims).
export function parseLinkedInPeople(html, { company } = {}) {
  const src = String(html ?? "");
  if (LOGIN_WALL_RE.test(src)) return [];
  const out = [];
  const seen = new Map();
  const anchorRe = /<a\b[^>]*href="(https?:\/\/(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+[^"]*|\/in\/[A-Za-z0-9_-]+[^"]*)"[^>]*>[\s\S]*?<\/a>/gi;
  for (const m of src.matchAll(anchorRe)) {
    const rawUrl = m[1];
    const handle = rawUrl.match(/\/in\/([A-Za-z0-9_-]+)/)?.[1];
    if (!handle) continue;
    const inner = m[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!looksLikeName(inner)) continue;
    const url = `https://www.linkedin.com/in/${handle}`;
    if (seen.has(url)) continue;
    const after = src.slice(m.index, m.index + 1200);
    const t = after.match(/entity-result__primary-subtitle[^>]*>([^<]+)</);
    seen.set(url, {
      full_name: inner.split("·")[0].split("|")[0].split(",")[0].trim(),
      title: t ? t[1].trim() : null,
      linkedin_url: url,
      company: company ?? null,
    });
  }
  for (const row of seen.values()) out.push(row);
  return out;
}

function bskCli(args, timeoutMs = 90000) {
  return execFileSync("bsk", args, {
    encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
  });
}

// Real driver: an isolated, unfocussed Agent Window over the user's session.
// Always stops the session, success or failure.
function realDriver() {
  return async (url) => {
    const start = JSON.parse(bskCli(["session", "start", "--json", "--no-focus", "--name", "reach-fetch"]));
    const sid = start?.session?.id ?? start?.session_id ?? start?.id;
    if (!sid) throw new Error("bsk session start returned no session id");
    try {
      bskCli(["navigate", url, "--session", sid, "--wait-until", "networkidle", "--timeout", "45s"]);
      const raw = bskCli(["get-html", "--session", sid, "--json"]);
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* plain text output */ }
      return parsed?.html ?? parsed?.content ?? String(raw);
    } finally {
      try { bskCli(["session", "stop", String(sid)]); } catch { /* teardown is best-effort */ }
    }
  };
}

export async function fetchLinkedInPeople(
  db, cfg,
  { company, keywords = "recruiter", limit = 12, driver = realDriver(), agent = "prospect" } = {},
) {
  let rows = [];
  const urls = [];
  if (company) {
    urls.push(buildPeopleSearchUrl({ company, keywords }));
    urls.push(keywordFallbackUrl({ company, keywords }));
  } else {
    urls.push(buildPeopleSearchUrl({ keywords }));
  }
  for (const url of urls) {
    let html;
    try {
      html = await driver(url);
    } catch (err) {
      return { imported: 0, skipped: 0, reason: `fetch_error: ${String(err.message || err).slice(0, 120)}` };
    }
    if (LOGIN_WALL_RE.test(html)) return { imported: 0, skipped: 0, reason: "not_logged_in" };
    rows = parseLinkedInPeople(html, { company });
    if (rows.length) break;
  }
  const capped = rows.slice(0, limit);
  let imported = 0;
  let skipped = 0;
  for (const row of capped) {
    if (!row.full_name) { skipped += 1; continue; }
    const companyId = row.company ? upsertCompany(db, { name: row.company }) : null;
    const res = upsertPerson(db, {
      full_name: row.full_name,
      title: row.title,
      companyId,
      linkedin_url: row.linkedin_url,
      persona: personaFromTitle(row.title),
      source: "linkedin_search",
      agent,
    });
    if (res) imported += 1; else skipped += 1;
  }
  recordEvent(db, {
    agent, entity: "person", action: "linkedin_fetched",
    detail: { company: company ?? null, keywords, found: rows.length, imported, skipped },
  });
  return { imported, skipped, reason: null };
}
