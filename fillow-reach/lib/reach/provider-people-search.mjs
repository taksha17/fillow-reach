// Own-key people search (PRD R1-10): runs only when the user configured a key
// AND set a non-zero monthly_quota. Provider errors (4xx/5xx/network) put the
// provider on a run-scoped cooldown — never fatal to the batch.
function monthNow() {
  return new Date().toISOString().slice(0, 7);
}

function readUsage(db, provider) {
  try {
    return db.prepare("SELECT calls FROM provider_usage WHERE provider=? AND month=?").get(provider, monthNow())?.calls ?? 0;
  } catch {
    return 0;
  }
}

function countUsage(db, provider) {
  db.prepare(
    "INSERT INTO provider_usage (provider, month, calls) VALUES (?,?,1) ON CONFLICT(provider, month) DO UPDATE SET calls=calls+1"
  ).run(provider, monthNow());
}

async function searchApollo(key, { company, domain, fetchImpl }) {
  const body = domain
    ? { organization_domains: [domain], page_size: 10 }
    : { q_keywords: company, page_size: 10 };
  const r = await fetchImpl("https://api.apollo.io/v1/mixed_people/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": key },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { error: r.status };
  let data;
  try {
    data = JSON.parse(await r.text());
  } catch {
    return { error: "parse" };
  }
  const people = Array.isArray(data.people) ? data.people : [];
  return {
    drafts: people.map((p) => ({
      full_name: [p.first_name, p.last_name].filter(Boolean).join(" ") || null,
      title: p.title ?? null,
      linkedin_url: p.linkedin_url ?? null,
      source: "apollo",
    })).filter((d) => d.full_name),
  };
}

async function searchHunter(key, { domain, fetchImpl }) {
  if (!domain) return { drafts: [] }; // domain-search needs a domain; no guessing
  const r = await fetchImpl(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(key)}&limit=10`);
  if (!r.ok) return { error: r.status };
  let data;
  try {
    data = JSON.parse(await r.text());
  } catch {
    return { error: "parse" };
  }
  const emails = Array.isArray(data?.data?.emails) ? data.data.emails : [];
  return {
    drafts: emails.map((e) => ({
      full_name: [e.first_name, e.last_name].filter(Boolean).join(" ") || null,
      title: e.position ?? null,
      email: e.value ?? null,
      source: "hunter",
    })).filter((d) => d.full_name),
  };
}

export async function searchPeople(reachCfg, { company, domain = null, db = null, fetchImpl = globalThis.fetch, cooldown = new Set() } = {}) {
  const out = [];
  for (const provider of ["apollo", "hunter"]) {
    const quota = reachCfg.enrichment.monthlyQuota[provider] ?? 0;
    const key = provider === "apollo" ? reachCfg.enrichment.apolloKey : reachCfg.enrichment.hunterKey;
    if (!quota || !key || cooldown.has(provider)) continue;
    if (db && readUsage(db, provider) >= quota) { cooldown.add(provider); continue; }
    let result;
    try {
      result = provider === "apollo"
        ? await searchApollo(key, { company, domain, fetchImpl })
        : await searchHunter(key, { domain, fetchImpl });
    } catch {
      cooldown.add(provider);
      continue;
    }
    if (result.error) { cooldown.add(provider); continue; }
    if (db) countUsage(db, provider);
    out.push(...result.drafts);
  }
  return out;
}
