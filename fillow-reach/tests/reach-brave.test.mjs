import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { buildBraveQuery, parseBravePeople, fetchBravePeople } from "../lib/reach/provider-brave.mjs";

function fixture({ envText = "BRAVE_API_KEY=bk-test\n", profileYaml = "reach:\n  enabled: true\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reach-brave-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, profileYaml, "utf8");
  writeFileSync(envFile, envText, "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir });
  const db = openReachMigratedDb(cfg);
  return { db, cfg, dir };
}

const BRAVE_FIXTURE = {
  web: {
    results: [
      {
        title: "Jane Doe - Technical Recruiter at Airbnb | LinkedIn",
        url: "https://www.linkedin.com/in/janedoe/",
        description: "Technical Recruiter at Airbnb. San Francisco Bay Area.",
      },
      {
        title: "John Roe | LinkedIn",
        url: "https://www.linkedin.com/in/john-roe-5571b42",
        description: "Senior Machine Learning Engineer, Airbnb.",
      },
      {
        title: "Airbnb - Technology Company | LinkedIn", // company page, must be ignored
        url: "https://www.linkedin.com/company/airbnb/",
        description: "About Airbnb.",
      },
      {
        title: "Jane Doe - Technical Recruiter at Airbnb | LinkedIn", // duplicate of the first hit
        url: "https://www.linkedin.com/in/janedoe?original_referer=x",
        description: "dup",
      },
    ],
  },
};

test("1. buildBraveQuery formats site-scoped quoted search", () => {
  assert.equal(
    buildBraveQuery({ company: "airbnb", keywords: "recruiter" }),
    'site:linkedin.com/in "recruiter" "airbnb"',
  );
  assert.equal(buildBraveQuery({ keywords: "recruiter" }), 'site:linkedin.com/in "recruiter"');
  assert.equal(
    buildBraveQuery({ company: "Acme Inc", keywords: "talent acquisition" }),
    'site:linkedin.com/in "talent acquisition" "Acme Inc"',
  );
});

test("2. parseBravePeople keeps /in/ profiles only, pulls name+title, dedupes", () => {
  const rows = parseBravePeople(BRAVE_FIXTURE, { company: "airbnb" });
  assert.equal(rows.length, 2);
  const jane = rows.find((r) => r.linkedin_url.includes("janedoe"));
  assert.equal(jane.full_name, "Jane Doe");
  assert.equal(jane.title, "Technical Recruiter at Airbnb");
  const john = rows.find((r) => r.linkedin_url.includes("john-roe-5571b42"));
  assert.equal(john.full_name, "John Doe".replace("Doe", "Roe"));
  assert.equal(john.title, null); // title was only in the description; unused unless in the link text
});

test("3. fetchBravePeople imports through the pipeline, source public_page, counts provider usage", async () => {
  const { db, cfg } = fixture();
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => BRAVE_FIXTURE });
  const res = await fetchBravePeople(db, cfg, { company: "airbnb", keywords: "recruiter", fetchImpl });
  assert.deepEqual({ imported: res.imported, skipped: res.skipped, reason: res.reason }, { imported: 2, skipped: 0, reason: null });
  const row = db.prepare("SELECT full_name, persona, source FROM person WHERE full_name='Jane Doe'").get();
  assert.equal(row.persona, "recruiter");
  assert.equal(row.source, "public_page");
  const usage = db.prepare("SELECT calls FROM provider_usage WHERE provider='brave'").get();
  assert.equal(usage.calls, 1);
  const ev = db.prepare("SELECT action FROM event_log WHERE action='brave_imported'").get();
  assert.ok(ev);
  db.close();
});

test("4. no BRAVE_API_KEY → reason no_key, zero fetches", async () => {
  const { db, cfg } = fixture({ envText: "" });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => BRAVE_FIXTURE }; };
  const res = await fetchBravePeople(db, cfg, { company: "airbnb", fetchImpl });
  assert.deepEqual(res, { imported: 0, skipped: 0, reason: "no_key" });
  assert.equal(calls, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  db.close();
});

test("5. 429 puts brave on the cooldown set, no usage recorded", async () => {
  const { db, cfg } = fixture();
  const cooldown = new Set();
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => "rate limited" });
  const res = await fetchBravePeople(db, cfg, { company: "airbnb", fetchImpl, cooldown });
  assert.deepEqual(res, { imported: 0, skipped: 0, reason: "provider_error" });
  assert.ok(cooldown.has("brave"));
  assert.ok(!db.prepare("SELECT 1 FROM provider_usage WHERE provider='brave'").get());
  // second call inside the same run: skips without calling the provider
  let calls = 0;
  const res2 = await fetchBravePeople(db, cfg, { company: "x", fetchImpl: async () => { calls += 1; }, cooldown });
  assert.equal(res2.reason, "provider_error");
  assert.equal(calls, 0);
  db.close();
});
