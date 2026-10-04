import { recordEvent } from "./db.mjs";
import { upsertCompany, upsertPerson } from "./people.mjs";
import { personaFromTitle } from "./import-paste.mjs";
import { buildBraveQuery } from "./provider-brave.mjs";

// Auto-discovery via Google's Programmable Search JSON API (free 100/day, key
// + CSE id required): the query is Brave-shaped (`site:linkedin.com/in "role"
// "company"`) — the public web index is our LinkedIn directory, not LinkedIn
// itself. People land with source 'public_page' (the profile URL is the proof).
// Month-count quota, defaulting to 90/mo unless `monthly_quota.google` says
// otherwise, so a bad day of jobs can't burn the free allowance at once.

const CSE_URL = "https://www.googleapis.com/customsearch/v1";

export { buildBraveQuery as buildGoogleQuery };

function stripHtml(text) {
  return String(text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function titleFromHitTitle(title) {
  const cutPipe = String(title ?? "").split("|")[0].trim();
  const parts = cutPipe.split(/\s+[–—-]\s+|\s+·\s+/);
  if (parts.length >= 2) {
    const t = parts.slice(1).join(" - ").replace(/^\d+(st|nd|rd|th)\s+/, "").trim();
    return t || null;
  }
  return null;
}

export function parseGooglePeople(searchJson, { company } = {}) {
  const items = searchJson?.items;
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Map();
  for (const r of items) {
    const url = String(r?.link ?? "");
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

export async function fetchGooglePeople(
  db, cfg,
  { company, keywords = "recruiter", limit = 10, fetchImpl = globalThis.fetch, cooldown = new Set(), agent = "prospect" } = {},
) {
  const { googleKey, googleCx } = cfg.enrichment;
  if (!googleKey || !googleCx) return { imported: 0, skipped: 0, reason: "no_key" };
  if (cooldown.has("google")) return { imported: 0, skipped: 0, reason: "provider_error" };
  const month = new Date().toISOString().slice(0, 7);
  const quota = cfg.enrichment.googleQuota ?? 90; // free CSE tier floor; user can raise via monthly_quota.google
  const used = db.prepare("SELECT calls FROM provider_usage WHERE provider='google' AND month=?").get(month)?.calls ?? 0;
  if (used >= quota) return { imported: 0, skipped: 0, reason: "quota" };

  let json;
  try {
    const u = `${CSE_URL}?key=${googleKey}&cx=${googleCx}&q=${encodeURIComponent(buildBraveQuery({ company, keywords }))}&num=10`;
    const res = await fetchImpl(u, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      cooldown.add("google");
      return { imported: 0, skipped: 0, reason: "provider_error" };
    }
    json = typeof res.json === "function" ? await res.json() : JSON.parse(await res.text());
  } catch {
    cooldown.add("google");
    return { imported: 0, skipped: 0, reason: "provider_error" };
  }

  const rows = parseGooglePeople(json, { company }).slice(0, limit);
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
  db.prepare(
    "INSERT INTO provider_usage (provider, month, calls) VALUES ('google', ?, 1) "
    + "ON CONFLICT(provider, month) DO UPDATE SET calls = calls + 1",
  ).run(month);
  recordEvent(db, {
    agent, entity: "person", action: "google_imported",
    detail: { company: company ?? null, keywords, found: rows.length, imported, skipped },
  });
  return { imported, skipped, reason: null };
}
