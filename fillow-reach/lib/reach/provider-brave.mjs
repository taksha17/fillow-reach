import { recordEvent } from "./db.mjs";
import { upsertCompany, upsertPerson } from "./people.mjs";
import { personaFromTitle } from "./import-paste.mjs";

// Auto-discovery without a LinkedIn session: Brave's web index already knows
// every public LinkedIn profile, so we query `site:linkedin.com/in` for the
// target company/role and treat each hit as a candidate. LinkedIn itself is
// never contacted — no login, no session, no scraped page. People land with
// source 'public_page' (a public profile page is literally their proof of
// existence); the `brave_imported` event carries the provider attribution.

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";

export function buildBraveQuery({ company, keywords = "recruiter" } = {}) {
  return `site:linkedin.com/in "${keywords}"${company ? ` "${company}"` : ""}`;
}

function stripHtml(text) {
  return String(text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function titleFromHitTitle(title) {
  // Brave title shapes: "Name - Role | LinkedIn", "Name · 2nd Role", "Name | LinkedIn"
  const cutPipe = String(title ?? "").split("|")[0].trim();
  const parts = cutPipe.split(/\s+[–—-]\s+|\s+·\s+/);
  if (parts.length >= 2) return parts.slice(1).join(" - ").replace(/^\d+(st|nd|rd|th)\s+/, "").trim() || null;
  return null;
}

export function parseBravePeople(searchJson, { company } = {}) {
  const results = searchJson?.web?.results;
  if (!Array.isArray(results)) return [];
  const out = [];
  const seen = new Map();
  for (const r of results) {
    const url = String(r?.url ?? "");
    const handle = url.match(/linkedin\.com\/in\/([A-Za-z0-9_-]+)/)?.[1];
    if (!handle) continue;
    const title = stripHtml(r?.title ?? "");
    const name = title.split(/\s+[–—-]\s+|\s+·\s+|\s+\|/)[0].trim();
    if (!/^[A-Z]/.test(name) || name.length < 2 || name.length > 60) continue;
    const key = `https://www.linkedin.com/in/${handle}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      full_name: name.replace(/\s+Verified$/, "").trim(),
      title: titleFromHitTitle(title),
      linkedin_url: key,
      company: company ?? null,
    });
  }
  return [...seen.values()];
}

export async function fetchBravePeople(
  db, cfg,
  { company, keywords = "recruiter", limit = 10, fetchImpl = globalThis.fetch, cooldown = new Set(), agent = "prospect" } = {},
) {
  if (!cfg.enrichment?.braveKey) return { imported: 0, skipped: 0, reason: "no_key" };
  if (cooldown.has("brave")) return { imported: 0, skipped: 0, reason: "provider_error" };

  let json;
  try {
    const u = `${BRAVE_URL}?q=${encodeURIComponent(buildBraveQuery({ company, keywords }))}&count=${Math.max(limit, 10)}`;
    const res = await fetchImpl(u, { headers: { Accept: "application/json", "X-Subscription-Token": cfg.enrichment.braveKey } });
    if (!res.ok) {
      cooldown.add("brave");
      return { imported: 0, skipped: 0, reason: "provider_error" };
    }
    json = typeof res.json === "function" ? await res.json() : JSON.parse(await res.text());
  } catch {
    cooldown.add("brave");
    return { imported: 0, skipped: 0, reason: "provider_error" };
  }

  const rows = parseBravePeople(json, { company }).slice(0, limit);
  let imported = 0;
  let skipped = 0;
  for (const row of rows) {
    const companyId = row.company ? upsertCompany(db, { name: row.company }) : null;
    const r = upsertPerson(db, {
      full_name: row.full_name,
      title: row.title,
      companyId,
      linkedin_url: row.linkedin_url,
      persona: personaFromTitle(row.title),
      source: "public_page",
      agent,
    });
    if (r) imported += 1; else skipped += 1;
  }
  // usage is tracked per month for the user's own key; Brave has no explicit
  // reach quota (the free tier self-limits with 429s, which trip the cooldown)
  db.prepare(
    "INSERT INTO provider_usage (provider, month, calls) VALUES ('brave', ?, 1) "
    + "ON CONFLICT(provider, month) DO UPDATE SET calls = calls + 1",
  ).run(new Date().toISOString().slice(0, 7));
  recordEvent(db, {
    agent, entity: "person", action: "brave_imported",
    detail: { company: company ?? null, keywords, found: rows.length, imported, skipped },
  });
  return { imported, skipped, reason: null };
}
