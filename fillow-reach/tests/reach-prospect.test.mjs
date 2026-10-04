import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { importPaste } from "../lib/reach/import-paste.mjs";
import { searchPeople } from "../lib/reach/provider-people-search.mjs";
import { run } from "../agents/reach-prospect.mjs";
import { runReachCli } from "../lib/reach/cli.mjs";

function fixture(profileYaml = "reach:\n  enabled: true\n", envText = "") {
  const dir = mkdtempSync(join(tmpdir(), "reach-prospect-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, profileYaml, "utf8");
  writeFileSync(envFile, envText, "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir });
  const db = openReachMigratedDb(cfg);
  return { db, cfg, dir, profileFile, envFile, dataDir };
}

const JOBS = [
  { source: "greenhouse", external_id: "g-1", title: "Recruiter", company: "Acme Inc", status: "ready" },
  { source: "ashby", external_id: "a-1", title: "Recruiter", company: "Beta LLC", status: "applied" },
];

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) };
}

test("1. run: two in-memory jobs + two paste people -> targets synced, queued >= 1", async () => {
  const { db, cfg } = fixture();
  importPaste(db, "Jane Doe — Technical Recruiter at Acme\nlinkedin.com/in/jane-doe", { apply: true });
  importPaste(db, "John Roe — Recruiter at Beta\nlinkedin.com/in/john-roe", { apply: true });
  db.close();
  const out = await run(cfg, { jobs: JOBS });
  assert.equal(out.targets, 2);
  assert.ok(out.queued >= 1, JSON.stringify(out));
  const db2 = openReachMigratedDb(cfg);
  assert.ok(db2.prepare("SELECT COUNT(*) AS n FROM connection WHERE status='queued'").get().n >= 1);
  db2.close();
});

test("2. run: no jobs at all -> paste-only source still runs, person held as prospect (score gate)", async () => {
  const { db, cfg } = fixture();
  importPaste(db, "Jane Doe — Technical Recruiter at Zeta\nlinkedin.com/in/jane-doe", { apply: true });
  db.close();
  const out = await run(cfg, { jobs: [] });
  assert.equal(out.targets, 0);
  assert.equal(out.queued, 0); // no live target -> relevance 40 < 70: stays prospect, never fails
  const db2 = openReachMigratedDb(cfg);
  assert.equal(db2.prepare("SELECT lifecycle FROM person WHERE full_name='Jane Doe'").get().lifecycle, "prospect");
  db2.close();
});

test("3. searchPeople: both quotas 0 -> [] without fetching", async () => {
  const { cfg } = fixture();
  let calls = 0;
  const drafts = await searchPeople(cfg, { company: "Acme", fetchImpl: async () => { calls += 1; return res(200, "{}"); } });
  assert.deepEqual(drafts, []);
  assert.equal(calls, 0);
});

test("4. searchPeople: hunter 429 -> cooldown skip, no throw; a 200 apollo pass still returns drafts", async () => {
  const { cfg } = fixture(
    "reach:\n  enabled: true\n  enrichment:\n    monthly_quota: { hunter: 50, apollo: 50 }\n",
    "HUNTER_API_KEY=hk\nAPOLLO_API_KEY=ak\n",
  );
  const cooldown = new Set();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (url.includes("hunter")) return res(429, "{}");
    return res(200, JSON.stringify({
      people: [{ first_name: "Ada", last_name: "Lovelace", title: "Recruiter" }],
    }));
  };
  const drafts = await searchPeople(cfg, { company: "Acme", domain: "acme.test", fetchImpl, cooldown });
  assert.equal(drafts.length, 1, JSON.stringify(drafts));
  assert.equal(drafts[0].full_name, "Ada Lovelace");
  assert.equal(drafts[0].source, "apollo");
  assert.ok(cooldown.has("hunter"));
  assert.equal(calls.length, 2);
});

test("5. run with a 429-ing provider: local paste people still queue", async () => {
  const { db, cfg } = fixture(
    "reach:\n  enabled: true\n  enrichment:\n    monthly_quota: { hunter: 50 }\n",
    "HUNTER_API_KEY=hk\n",
  );
  importPaste(db, "Jane Doe — Technical Recruiter at Acme\nlinkedin.com/in/jane-doe", { apply: true });
  db.close();
  const fetchImpl = async () => res(429, "{}");
  const out = await run(cfg, { jobs: JOBS, fetchImpl });
  assert.ok(out.queued >= 1, JSON.stringify(out));
});

test("6. CLI prospect: exit 0, prints queued count", async () => {
  const fx = fixture();
  let out = "";
  const code = await runReachCli(["prospect"], { stdout: { write: (s) => { out += String(s); } }, ...fx });
  assert.equal(code, 0, out);
  assert.ok(/queued/i.test(out), out);
});

test("7. prospect pulls people from Brave when BRAVE_API_KEY is set (no browser session)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-brave-prospect-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, "reach:\n  enabled: true\n", "utf8");
  writeFileSync(envFile, "BRAVE_API_KEY=bk-test\n", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir: join(dir, "data") });
  const braveFixture = {
    web: { results: [{
      title: "Ada Recruit - Technical Recruiter at airbnb | LinkedIn",
      url: "https://www.linkedin.com/in/adarecruit",
      description: "Technical Recruiter at airbnb.",
    }] },
  };
  let braveCalls = 0;
  const fetchImpl = async (u) => {
    if (String(u).includes("brave")) { braveCalls += 1; return { ok: true, status: 200, json: async () => braveFixture }; }
    return { ok: true, status: 200, json: async () => ({ people: [] }) };
  };
  const out = await run(cfg, {
    fetchImpl,
    jobs: [{ source: "greenhouse", external_id: "g-1", title: "Recruiter", company: "airbnb", status: "ready" }],
  });
  assert.ok(braveCalls >= 1);
  assert.ok(out.queued >= 1, JSON.stringify(out));
  const db2 = openReachMigratedDb(cfg);
  const p = db2.prepare("SELECT full_name, persona, source FROM person WHERE full_name='Ada Recruit'").get();
  assert.equal(p.persona, "recruiter");
  assert.equal(p.source, "public_page");
  db2.close();
});

test("8. prospect pulls people from Google CSE when GOOGLE_CSE_KEY/ID are set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-google-prospect-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, "reach:\n  enabled: true\n", "utf8");
  writeFileSync(envFile, "GOOGLE_CSE_KEY=gs-key\nGOOGLE_CSE_ID=gs-cx\n", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir: join(dir, "data") });
  const googleFixture = {
    items: [{
      title: "Ada Recruit - Technical Recruiter at airbnb | LinkedIn",
      link: "https://www.linkedin.com/in/adarecruit",
      snippet: "...",
    }],
  };
  let googleCalls = 0;
  const fetchImpl = async (u) => {
    if (String(u).includes("googleapis.com/customsearch")) { googleCalls += 1; return { ok: true, status: 200, json: async () => googleFixture }; }
    return { ok: true, status: 200, json: async () => ({ people: [] }) };
  };
  const out = await run(cfg, {
    fetchImpl,
    jobs: [{ source: "greenhouse", external_id: "g-1", title: "Recruiter", company: "airbnb", status: "ready" }],
  });
  assert.ok(googleCalls >= 1);
  assert.ok(out.queued >= 1, JSON.stringify(out));
  const db2 = openReachMigratedDb(cfg);
  const p = db2.prepare("SELECT full_name, persona, source FROM person WHERE full_name='Ada Recruit'").get();
  assert.equal(p.persona, "recruiter");
  assert.equal(p.source, "public_page");
  db2.close();
});

test("9. without search keys, discovery.reason is no_key and no provider is called", async () => {
  const { cfg } = fixture();
  let calls = 0;
  const out = await run(cfg, {
    jobs: JOBS,
    fetchImpl: async () => { calls += 1; return res(200, "{}"); },
  });
  assert.equal(out.discovery.reason, "no_key");
  assert.equal(out.discovery.searched, 0);
  assert.equal(calls, 0);
});

test("10. Google CSE searches at most invitesPerDay companies (cron-safe; never bsk)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-google-budget-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, "reach:\n  enabled: true\n", "utf8");
  writeFileSync(envFile, "GOOGLE_CSE_KEY=gs-key\nGOOGLE_CSE_ID=gs-cx\n", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir: join(dir, "data") });
  const jobs = Array.from({ length: 20 }, (_, i) => ({
    source: "greenhouse",
    external_id: `g-${i}`,
    title: "Recruiter",
    company: `Co${i}`,
    status: "ready",
  }));
  let googleCalls = 0;
  const fetchImpl = async (u) => {
    if (String(u).includes("googleapis.com/customsearch")) {
      googleCalls += 1;
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ people: [] }) };
  };
  const out = await run(cfg, { fetchImpl, jobs });
  assert.equal(out.discovery.provider, "google");
  assert.equal(out.discovery.searched, cfg.limits.invitesPerDay);
  assert.equal(googleCalls, cfg.limits.invitesPerDay);
});
