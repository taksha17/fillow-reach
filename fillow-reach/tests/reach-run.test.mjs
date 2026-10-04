import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { runDailyCycle } from "../lib/reach/run.mjs";
import { runReachCli } from "../lib/reach/cli.mjs";
import { upsertCompany, upsertPerson } from "../lib/reach/people.mjs";

function fixture(yaml = "reach:\n  enabled: true\n  dry_run: true\n") {
  const dir = mkdtempSync(join(tmpdir(), "reach-run-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, yaml, "utf8");
  writeFileSync(envFile, "", "utf8");
  return { profileFile, envFile, dataDir: join(dir, "data") };
}

async function cli(argv, fx) {
  let out = "";
  const code = await runReachCli(argv, { stdout: { write: (s) => { out += String(s); } }, ...fx });
  return { code, out };
}

test("1. empty fixture: daily cycle does not throw; each phase returns stats", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const stats = await runDailyCycle(cfg, { send: false, now: new Date("2026-10-04T12:00:00Z") });
  assert.ok(stats.prospect);
  assert.equal(typeof stats.prospect.queued, "number");
  assert.ok(stats.contacts);
  assert.ok(stats.outreach);
  assert.equal(stats.outreach.sent, 0, "dry cycle never sends");
  assert.ok(stats.jsonl);
  assert.ok(stats.report);
  assert.equal(stats.report.status, "built");
  assert.deepEqual(stats.errors, []);
});

test("2. --send in dry_run still does not mark messages sent", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const stats = await runDailyCycle(cfg, { send: true, now: new Date("2026-10-04T12:00:00Z") });
  assert.equal(cfg.dryRun, true);
  assert.equal(stats.outreach.sent ?? 0, 0);
  assert.notEqual(stats.report.status, "sent");
});

test("3. a failing prospect phase does not skip contacts/outreach/jsonl", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const stats = await runDailyCycle(cfg, {
    send: false,
    now: new Date("2026-10-04T12:00:00Z"),
    prospectImpl: async () => { throw new Error("boom prospect"); },
    contactsImpl: async () => ({ accepted: 0, unmatched: 0, hard: 0, soft: 0, enriched: 0 }),
    outreachImpl: async () => ({ composed: 0, sent: 0, skipped: 0, grounded: 0, ungrounded: 0 }),
  });
  assert.equal(stats.errors.length, 1);
  assert.equal(stats.errors[0].agent, "prospect");
  assert.match(stats.errors[0].error, /boom prospect/);
  assert.ok(stats.contacts);
  assert.ok(stats.outreach);
  assert.ok(stats.jsonl);
});

test("4. JSONL file is written under data/reach/", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  const companyId = upsertCompany(db, { name: "Acme" });
  upsertPerson(db, { full_name: "Ada Lovelace", companyId, source: "manual" });
  db.close();
  await runDailyCycle(cfg, { send: false, now: new Date() });
  const files = existsSync(cfg.paths.eventsDir) ? readdirSync(cfg.paths.eventsDir) : [];
  assert.ok(files.some((f) => /^events-.*\.jsonl$/.test(f)), files.join(","));
});

test("5. CLI `reach run --json` is registered and exits 0 on an empty db", async () => {
  const fx = fixture();
  const { code, out } = await cli(["run", "--json"], fx);
  assert.equal(code, 0, out);
  const j = JSON.parse(out);
  assert.ok(j.prospect);
  assert.ok(j.outreach);
  assert.deepEqual(j.errors, []);
});

test("6. help lists reach run", async () => {
  const fx = fixture();
  const { out } = await cli([], fx);
  assert.match(out, /reach run\b/);
});
