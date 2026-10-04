import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { buildGoogleQuery, parseGooglePeople, fetchGooglePeople } from "../lib/reach/provider-google.mjs";

function fixture({ envText = "GOOGLE_CSE_KEY=gs-key\nGOOGLE_CSE_ID=gs-cx\n", profileYaml = "reach:\n  enabled: true\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reach-google-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, profileYaml, "utf8");
  writeFileSync(envFile, envText, "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir });
  const db = openReachMigratedDb(cfg);
  return { db, cfg, dir };
}

const GOOGLE_FIXTURE = {
  items: [
    { title: "Jane Doe - Technical Recruiter at Airbnb | LinkedIn", link: "https://www.linkedin.com/in/janedoe/", snippet: "..." },
    { title: "John Roe | LinkedIn", link: "https://www.linkedin.com/in/john-roe-5571b42", snippet: "..." },
    { title: "Airbnb - Technology Company | LinkedIn", link: "https://www.linkedin.com/company/airbnb/", snippet: "..." },
    { title: "Jane Doe - Technical Recruiter at Airbnb | LinkedIn", link: "https://www.linkedin.com/in/janedoe?utm_source=x", snippet: "dup" },
  ],
};

test("1. buildGoogleQuery formats site-scoped quoted search", () => {
  assert.equal(
    buildGoogleQuery({ company: "airbnb", keywords: "recruiter" }),
    'site:linkedin.com/in "recruiter" "airbnb"',
  );
  assert.equal(buildGoogleQuery({ keywords: "recruiter" }), 'site:linkedin.com/in "recruiter"');
});

test("2. parseGooglePeople keeps /in/ profiles only, pulls name+title, dedupes", () => {
  const rows = parseGooglePeople(GOOGLE_FIXTURE, { company: "airbnb" });
  assert.equal(rows.length, 2);
  const jane = rows.find((r) => r.linkedin_url.includes("janedoe"));
  assert.equal(jane.full_name, "Jane Doe");
  assert.equal(jane.title, "Technical Recruiter at Airbnb");
  const john = rows.find((r) => r.linkedin_url.includes("john-roe-5571b42"));
  assert.equal(john.full_name, "John Roe");
  assert.equal(john.title, null);
});

test("3. fetchGooglePeople imports through the pipeline, source public_page, counts provider usage", async () => {
  const { db, cfg } = fixture();
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => GOOGLE_FIXTURE });
  const res = await fetchGooglePeople(db, cfg, { company: "airbnb", keywords: "recruiter", fetchImpl });
  assert.deepEqual({ imported: res.imported, skipped: res.skipped, reason: res.reason }, { imported: 2, skipped: 0, reason: null });
  const row = db.prepare("SELECT full_name, persona, source FROM person WHERE full_name='Jane Doe'").get();
  assert.equal(row.persona, "recruiter");
  assert.equal(row.source, "public_page");
  const usage = db.prepare("SELECT calls FROM provider_usage WHERE provider='google'").get();
  assert.equal(usage.calls, 1);
  const ev = db.prepare("SELECT action FROM event_log WHERE action='google_imported'").get();
  assert.ok(ev);
  db.close();
});

test("4. no creds → reason no_key, zero fetches", async () => {
  const { db, cfg } = fixture({ envText: "" });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => GOOGLE_FIXTURE }; };
  const res = await fetchGooglePeople(db, cfg, { company: "airbnb", fetchImpl });
  assert.deepEqual(res, { imported: 0, skipped: 0, reason: "no_key" });
  assert.equal(calls, 0);
  db.close();
});

test("5. free-tier monthly quota: 90 calls in provider_usage → reason quota, zero fetches", async () => {
  const { db, cfg } = fixture();
  db.prepare("INSERT INTO provider_usage (provider, month, calls) VALUES ('google', ?, 90)")
    .run(new Date().toISOString().slice(0, 7));
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => GOOGLE_FIXTURE }; };
  const res = await fetchGooglePeople(db, cfg, { company: "airbnb", fetchImpl });
  assert.deepEqual(res, { imported: 0, skipped: 0, reason: "quota" });
  assert.equal(calls, 0);
  db.close();
});

test("6. 429 puts google on cooldown, no usage recorded", async () => {
  const { db, cfg } = fixture();
  const cooldown = new Set();
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => "rate limited" });
  const res = await fetchGooglePeople(db, cfg, { company: "airbnb", fetchImpl, cooldown });
  assert.deepEqual(res, { imported: 0, skipped: 0, reason: "provider_error" });
  assert.ok(cooldown.has("google"));
  assert.ok(!db.prepare("SELECT 1 FROM provider_usage WHERE provider='google'").get());
  db.close();
});

