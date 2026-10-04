import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { buildPeopleSearchUrl, parseLinkedInPeople, fetchLinkedInPeople } from "../lib/reach/linkedin-fetch.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reach-lifetch-"));
  const profileFile = join(dir, "profile.yaml");
  writeFileSync(profileFile, "reach:\n  enabled: true\n", "utf8");
  writeFileSync(join(dir, ".env"), "", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile: join(dir, ".env"), dataDir: join(dir, "data") });
  const db = openReachMigratedDb(cfg);
  return { db, cfg, dir };
}

const SEARCH_HTML = `
<div class="search-results-container">
  <div class="entity-result" data-chameleon-result-urn="li:fsd_profile:1">
    <a class="app-aware-link" href="https://www.linkedin.com/in/jane-doe?miniProfileUrn=x" target="_self">
      <span dir="ltr"><span aria-hidden="true">Jane Doe</span></span>
    </a>
    <div class="entity-result__primary-subtitle">Technical Recruiter at Airbnb</div>
  </div>
  <div class="entity-result" data-chameleon-result-urn="li:fsd_profile:2">
    <a class="app-aware-link" href="/in/john-roe" target="_self">
      <span dir="ltr"><span aria-hidden="true">John Roe</span></span>
    </a>
    <div class="entity-result__primary-subtitle">Engineering Manager at Airbnb</div>
  </div>
  <div class="entity-result" data-chameleon-result-urn="li:fsd_profile:1">
    <a class="app-aware-link" href="https://www.linkedin.com/in/jane-doe" target="_self">
      <span dir="ltr"><span aria-hidden="true">Jane Doe</span></span>
    </a>
    <div class="entity-result__primary-subtitle">Technical Recruiter at Airbnb</div>
  </div>
</div>`;

test("1. buildPeopleSearchUrl: company page for slugs, keyword fallback otherwise", () => {
  assert.equal(
    buildPeopleSearchUrl({ company: "airbnb", keywords: "recruiter" }),
    "https://www.linkedin.com/company/airbnb/people/?keywords=recruiter",
  );
  assert.equal(
    buildPeopleSearchUrl({ company: "Acme Inc", keywords: "recruiter OR talent" }),
    "https://www.linkedin.com/search/results/people/?keywords=recruiter%20OR%20talent%20Acme%20Inc",
  );
  assert.equal(
    buildPeopleSearchUrl({ keywords: "recruiter airbnb" }).startsWith("https://www.linkedin.com/search/results/people/?keywords="),
    true,
  );
});

test("2. parseLinkedInPeople extracts name/title/url, dedupes by profile, implies company", () => {
  const rows = parseLinkedInPeople(SEARCH_HTML, { company: "airbnb" });
  assert.equal(rows.length, 2);
  const jane = rows.find((r) => r.linkedin_url.includes("jane-doe"));
  assert.equal(jane.full_name, "Jane Doe");
  assert.equal(jane.title, "Technical Recruiter at Airbnb");
  assert.equal(jane.company, "airbnb");
});

test("3. schema v3 accepts source linkedin_search", () => {
  const { db } = fixture();
  const v = db.prepare("SELECT MAX(version) AS v FROM schema_version").get().v;
  assert.ok(v >= 3, `migration v3 not applied: ${v}`);
  db.prepare("INSERT INTO person (full_name, persona, source) VALUES ('X Y', 'recruiter', 'linkedin_search')").run();
  db.close();
});

test("4. fetchLinkedInPeople imports via the pipeline with source linkedin_search (stub driver)", async () => {
  const { db, cfg } = fixture();
  const driver = async (url) => SEARCH_HTML;
  const res = await fetchLinkedInPeople(db, cfg, { company: "airbnb", keywords: "recruiter", driver });
  assert.equal(res.imported, 2, JSON.stringify(res));
  assert.equal(res.reason, null);
  const rows = db.prepare("SELECT full_name, persona, source FROM person ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, "linkedin_search");
  assert.equal(rows[0].persona, "recruiter");
  const ev = db.prepare("SELECT action FROM event_log WHERE action='linkedin_fetched'").get();
  assert.ok(ev, "linkedin_fetched event missing");
  db.close();
});

test("5. fetchLinkedInPeople: login wall gives a reason and writes nothing", async () => {
  const { db, cfg } = fixture();
  const driver = async () => '<html><body><form id="login"><input id="login-email"></form></body></html>';
  const res = await fetchLinkedInPeople(db, cfg, { company: "airbnb", driver });
  assert.deepEqual(res, { imported: 0, skipped: 0, reason: "not_logged_in" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  db.close();
});

test("6. fetchLinkedInPeople pagination: driver sees company page first, then keyword fallback when empty", async () => {
  const { db, cfg } = fixture();
  const calls = [];
  const driver = async (url) => {
    calls.push(url);
    return calls.length === 1 ? "<html></html>" : SEARCH_HTML;
  };
  const res = await fetchLinkedInPeople(db, cfg, { company: "airbnb", keywords: "recruiter", driver });
  assert.equal(res.imported, 2);
  assert.ok(calls[0].includes("/company/airbnb/people/"));
  assert.ok(calls[1].includes("/search/results/people/"));
  db.close();
});
