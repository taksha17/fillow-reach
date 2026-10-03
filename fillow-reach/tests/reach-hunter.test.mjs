import test from "node:test";
import assert from "node:assert/strict";

import { openReachDb, migrateReachDb } from "../lib/reach/db.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertCompany, upsertPerson } from "../lib/reach/people.mjs";
import { enrichEmail } from "../lib/reach/provider-hunter.mjs";
import { incrementProviderUsage } from "../lib/reach/provider-usage.mjs";

function mem() {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return db;
}

function cfg(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reach-hunter-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, "reach:\n  enabled: true\n", "utf8");
  writeFileSync(envFile, "HUNTER_API_KEY=test-key\n", "utf8");
  const base = loadReachConfig({ profileFile, envFile, dataDir: join(dir, "data") });
  return {
    ...base,
    enrichment: { ...base.enrichment, ...over.enrichment, monthlyQuota: { ...base.enrichment.monthlyQuota, ...over.monthlyQuota } },
    email: { ...base.email, ...over.email },
  };
}

function seedPerson(db) {
  const companyId = upsertCompany(db, { name: "Acme", domain: "acme.com" });
  return upsertPerson(db, { full_name: "Jane Doe", companyId, source: "manual" }).personId;
}

test("1. quota 0 skips as disabled, no fetch", async () => {
  const db = mem();
  const personId = seedPerson(db);
  const reachCfg = cfg({ monthlyQuota: { hunter: 0 } });
  let calls = 0;
  const r = await enrichEmail(db, reachCfg, personId, { fetchImpl: async () => { calls += 1; return { ok: true, status: 200 }; }, cooldown: new Set() });
  assert.equal(r.skipped, "disabled");
  assert.equal(calls, 0);
  db.close();
});

test("2. 401 skips provider_error, no cache, no usage, second call no fetch", async () => {
  const db = mem();
  const personId = seedPerson(db);
  const reachCfg = cfg({ monthlyQuota: { hunter: 10 } });
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: false, status: 401, json: async () => ({}) }; };
  const cooldown = new Set();
  const a = await enrichEmail(db, reachCfg, personId, { fetchImpl, cooldown });
  assert.equal(a.skipped, "provider_error");
  const b = await enrichEmail(db, reachCfg, personId, { fetchImpl, cooldown });
  assert.equal(b.skipped, "provider_error");
  assert.equal(calls, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM enrichment_cache").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM provider_usage").get().n, 0);
  db.close();
});

test("3. 200 then cache hit does not fetch twice", async () => {
  const db = mem();
  const personId = seedPerson(db);
  const reachCfg = cfg({ monthlyQuota: { hunter: 10 } });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { email: "jane@acme.com", status: "valid", result: "valid", score: 90 } }),
    };
  };
  const cooldown = new Set();
  const a = await enrichEmail(db, reachCfg, personId, { fetchImpl, cooldown });
  const b = await enrichEmail(db, reachCfg, personId, { fetchImpl, cooldown });
  assert.equal(a.email, "jane@acme.com");
  assert.equal(a.fromCache, false);
  assert.equal(b.fromCache, true);
  assert.equal(calls, 1);
  db.close();
});

test("4. usage at quota skips", async () => {
  const db = mem();
  const personId = seedPerson(db);
  const reachCfg = cfg({ monthlyQuota: { hunter: 1 } });
  incrementProviderUsage(db, "hunter", 1);
  let calls = 0;
  const r = await enrichEmail(db, reachCfg, personId, {
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200 }; },
    cooldown: new Set(),
  });
  assert.equal(r.skipped, "quota");
  assert.equal(calls, 0);
  db.close();
});

test("5. risky stays risky when requireVerified", async () => {
  const db = mem();
  const personId = seedPerson(db);
  const reachCfg = cfg({ monthlyQuota: { hunter: 10 }, email: { requireVerified: true } });
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { email: "jane@acme.com", result: "risky", status: "invalid", score: 10 } }),
  });
  const r = await enrichEmail(db, reachCfg, personId, { fetchImpl, cooldown: new Set() });
  assert.equal(r.verification, "risky");
  const row = db.prepare("SELECT verification FROM email_address WHERE email = 'jane@acme.com'").get();
  assert.equal(row.verification, "risky");
  db.close();
});
