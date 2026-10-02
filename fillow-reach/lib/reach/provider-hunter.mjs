import { insertEmailAddress } from "./people.mjs";
import { incrementProviderUsage, readProviderUsage } from "./provider-usage.mjs";

const HUNTER_MAP = {
  valid: "valid",
  invalid: "invalid",
  accept_all: "accept_all",
  webmail: "risky",
  disposable: "risky",
  risky: "risky",
  unknown: "unknown",
};

function cacheKey(first, last, domain) {
  return `email_finder:${first}|${last}|${domain}`;
}

function mapVerification(data) {
  const raw = String(data?.result || data?.status || "unknown").toLowerCase();
  return HUNTER_MAP[raw] ?? "unknown";
}

export async function enrichEmail(db, reachCfg, personId, { fetchImpl = globalThis.fetch, cooldown = new Set() } = {}) {
  const order = reachCfg.enrichment?.order ?? [];
  if (!order.includes("hunter")) return { skipped: "not_in_order" };
  const quota = reachCfg.enrichment?.monthlyQuota?.hunter ?? 0;
  const key = reachCfg.enrichment?.hunterKey;
  if (!quota || !key) return { skipped: "disabled" };
  if (readProviderUsage(db, "hunter") >= quota) return { skipped: "quota" };
  if (cooldown.has("hunter")) return { skipped: "provider_error" };

  const person = db.prepare(
    `SELECT p.first_name, p.last_name, c.domain
     FROM person p LEFT JOIN company c ON c.id = p.company_id WHERE p.id = ?`,
  ).get(personId);
  const first = (person?.first_name || "").toLowerCase();
  const last = (person?.last_name || "").toLowerCase();
  const domain = (person?.domain || "").toLowerCase();
  if (!domain) return { skipped: "provider_error" };

  const qk = cacheKey(first, last, domain);
  const cached = db.prepare("SELECT response FROM enrichment_cache WHERE provider = 'hunter' AND query_key = ?").get(qk);
  if (cached) {
    const data = JSON.parse(cached.response);
    const email = data.email;
    const verification = mapVerification(data);
    const row = insertEmailAddress(db, { person_id: personId, email, source: "hunter", confidence: data.score ?? null, verification });
    if (!row) return { skipped: "provider_error" };
    return { email, verification, fromCache: true };
  }

  const url = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&api_key=${encodeURIComponent(key)}`;
  let res;
  try {
    res = await fetchImpl(url);
  } catch {
    cooldown.add("hunter");
    return { skipped: "provider_error" };
  }
  if (!res.ok || [401, 402, 429].includes(res.status)) {
    cooldown.add("hunter");
    return { skipped: "provider_error" };
  }
  const payload = await res.json();
  const data = payload.data ?? payload;
  const email = data.email;
  if (!email) return { skipped: "provider_error" };
  const verification = mapVerification(data);
  db.prepare(
    "INSERT INTO enrichment_cache (provider, query_key, response) VALUES ('hunter', ?, ?)",
  ).run(qk, JSON.stringify({ ...data, email, result: data.result || data.status, score: data.score }));
  incrementProviderUsage(db, "hunter");
  insertEmailAddress(db, { person_id: personId, email, source: "hunter", confidence: data.score ?? null, verification });
  return { email, verification, fromCache: false };
}
