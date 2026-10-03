import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { syncTargets, readJobsTsv } from "../lib/reach/targets.mjs";

function fixture(profileYaml = "reach:\n  enabled: true\n") {
  const dir = mkdtempSync(join(tmpdir(), "reach-targets-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, profileYaml, "utf8");
  writeFileSync(envFile, "", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir });
  const db = openReachMigratedDb(cfg);
  return { db, cfg, dir };
}

const READY_JOB = {
  source: "greenhouse", external_id: "gh-1", title: "Staff Engineer",
  company: "Acme Inc", url: "https://boards.acme.test/gh-1", status: "ready",
};

test("1. two jobs ready/applied -> two target_role rows, companies deduped", () => {
  const { db, cfg } = fixture();
  const res = syncTargets(db, cfg, {
    jobs: [
      READY_JOB,
      { ...READY_JOB, source: "ashby", external_id: "as-1", title: "ML Engineer", company: "Acme Inc", status: "applied" },
    ],
  });
  assert.equal(res.upserted, 2);
  assert.equal(res.skipped, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM target_role").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM company").get().n, 1);
  const row = db.prepare("SELECT job_ref FROM target_role WHERE job_ref=?").get("greenhouse:gh-1");
  assert.ok(row);
  db.close();
});

test("2. status 'closed' skipped; missing status kept (uncertain-kept)", () => {
  const { db, cfg } = fixture();
  const res = syncTargets(db, cfg, {
    jobs: [
      { ...READY_JOB, external_id: "gh-2", status: "closed" },
      { ...READY_JOB, external_id: "gh-3", status: "" },
    ],
  });
  assert.equal(res.upserted, 1);
  assert.equal(res.skipped, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM target_role").get().n, 1);
  const row = db.prepare("SELECT job_ref FROM target_role WHERE job_ref=?").get("greenhouse:gh-3");
  assert.ok(row, "missing-status job must be kept");
  db.close();
});

test("3. jobs: [] -> upserted 0, no throw (paste-only sources still run)", () => {
  const { db, cfg } = fixture();
  const res = syncTargets(db, cfg, { jobs: [] });
  assert.deepEqual(res, { targets: 0, upserted: 0, skipped: 0 });
  db.close();
});

test("4. second sync same job_ref updates title, row count unchanged", () => {
  const { db, cfg } = fixture();
  syncTargets(db, cfg, { jobs: [{ ...READY_JOB, title: "Staff Engineer" }] });
  const res = syncTargets(db, cfg, { jobs: [{ ...READY_JOB, title: "Principal Engineer" }] });
  assert.equal(res.upserted, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM target_role").get().n, 1);
  const row = db.prepare("SELECT title, status FROM target_role WHERE job_ref=?").get("greenhouse:gh-1");
  assert.equal(row.title, "Principal Engineer");
  assert.equal(row.status, "ready");
  db.close();
});

test("5. default jobs path: missing file -> zero targets, no throw", () => {
  const { db, cfg } = fixture();
  const res = syncTargets(db, cfg, {});
  assert.equal(res.targets, 0);
  db.close();
});

test("6. readJobsTsv parses header-mapped rows; empty file -> []", () => {
  const { dir } = fixture();
  const p = join(dir, "jobs.tsv");
  writeFileSync(p, "source\texternal_id\ttitle\tcompany\tlocation\turl\tapply_url\tats\tmatch_score\tstatus\n"
    + "lever\tlv-9\tData Scientist\tBeta LLC\tRemote\thttps://b.test/9\thttps://b.test/9\tlever\t88\tready\n", "utf8");
  const jobs = readJobsTsv(p);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].company, "Beta LLC");
  assert.equal(jobs[0].status, "ready");
  const empty = join(dir, "empty.tsv");
  writeFileSync(empty, "", "utf8");
  assert.deepEqual(readJobsTsv(empty), []);
  const missing = join(dir, "nope.tsv");
  assert.deepEqual(readJobsTsv(missing), []);
});

test("7. default path read: syncTargets picks up a real jobs.tsv in dataDir", () => {
  const { db, cfg } = fixture();
  mkdirSync(cfg.paths.dataDir, { recursive: true });
  const p = join(cfg.paths.dataDir, "jobs.tsv");
  writeFileSync(p, "source\texternal_id\ttitle\tcompany\tstatus\turnknown-col\n"
    + "greenhouse\tgh-x\tSRE\tGamma Corp\tready\twhatever\n", "utf8");
  const res = syncTargets(db, cfg, {});
  assert.equal(res.targets, 1);
  assert.equal(res.upserted, 1);
  db.close();
});
