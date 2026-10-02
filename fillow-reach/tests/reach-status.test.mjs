import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { renderStatus } from "../lib/reach/status.mjs";
import { runReachCli } from "../lib/reach/cli.mjs";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));

function fixture(profileYaml = "", envText = "") {
  const dir = mkdtempSync(join(tmpdir(), "reach-status-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, profileYaml, "utf8");
  writeFileSync(envFile, envText, "utf8");
  return { profileFile, envFile, dataDir };
}

const CFG = {
  dryRun: true,
  dryRunForcedByEnv: false,
  limits: { invitesPerDay: 15, invitesPer7d: 75, linkedinMessagesPer7d: 75, emailsPerDay: 15 },
};

const SNAP = {
  day: { invite: 3, linkedin_message: 0, email: 2 },
  week: { invite: 20, linkedin_message: 5, email: 2 },
};

function render(overrides = {}) {
  return renderStatus({
    reachCfg: CFG,
    snapshot: SNAP,
    paused: false,
    pausedAt: null,
    queues: { invitesQueued: 4, draftsAwaitingApproval: 1 },
    health: { acceptanceRate14d: null, bounceRate14d: null, halfTargets: false, emailPaused: false },
    dbVersion: 1,
    dbMissing: false,
    ...overrides,
  });
}

test("1. dry-run badge and schema line", () => {
  const out = render();
  assert.ok(out.includes("fillow Reach — status"));
  assert.ok(out.includes("mode        : DRY RUN ACTIVE"));
  assert.ok(!out.includes("forced by REACH_DRY_RUN"));
  assert.ok(out.includes("schema      : v1 (up to date)"));
});

test("2. forced dry-run marker", () => {
  const out = render({ reachCfg: { ...CFG, dryRunForcedByEnv: true } });
  assert.ok(out.includes("DRY RUN ACTIVE (forced by REACH_DRY_RUN)"));
});

test("3. kill switch line: off vs PAUSED (since iso)", () => {
  assert.ok(render().includes("kill switch : off"));
  const pausedOut = render({ paused: true, pausedAt: "2026-10-02T09:00:00.000Z" });
  assert.ok(pausedOut.includes("kill switch : PAUSED (since 2026-10-02T09:00:00.000Z)"));
});

test("4. cap counters pinned format", () => {
  const out = render();
  assert.ok(out.includes("today       : invites 3/15 · emails 2/15"));
  assert.ok(out.includes("last 7d     : invites 20/75 · linkedin messages 5/75"));
});

test("5. queue counts", () => {
  assert.ok(render().includes("queues      : 4 invites queued · 1 draft awaiting approval"));
});

test("6. health line: no data vs percentages", () => {
  assert.ok(render().includes("health      : no data yet"));
  const out = render({ health: { acceptanceRate14d: 0.43, bounceRate14d: 0.0, halfTargets: false, emailPaused: false } });
  assert.ok(/health      : acceptance 43% · bounce 0\.0%/.test(out));
});

test("7. missing DB adds the setup hint and stays renderable", () => {
  const out = render({ dbMissing: true, dbVersion: null });
  assert.ok(/reach setup/.test(out));
});

test("8. CLI status --json (spawn) emits the pinned keys, exit 0", () => {
  const fx = fixture();
  const res = spawnSync(process.execPath, ["bin/reach.mjs", "status", "--json"], {
    cwd: PKG_DIR,
    env: { PATH: process.env.PATH, REACH_PROFILE_FILE: fx.profileFile, REACH_DATA_DIR: fx.dataDir, REACH_ENV_FILE: fx.envFile },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  for (const key of ["dryRun", "paused", "today", "last7d", "queues", "health", "schemaVersion"]) {
    assert.ok(key in parsed, `missing key ${key}`);
  }
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.paused, false);
});

test("9. CLI status on a missing DB: zeros + setup hint, exit 0, no db created", () => {
  const fx = fixture();
  const res = spawnSync(process.execPath, ["bin/reach.mjs", "status"], {
    cwd: PKG_DIR,
    env: { PATH: process.env.PATH, REACH_PROFILE_FILE: fx.profileFile, REACH_DATA_DIR: fx.dataDir, REACH_ENV_FILE: fx.envFile },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes("0/15"));
  assert.ok(/reach setup/.test(res.stdout));
  assert.equal(existsSync(join(fx.dataDir, "reach.db")), false);
});

test("10. bare argv prints usage, exit 1", () => {
  const fx = fixture();
  const res = spawnSync(process.execPath, ["bin/reach.mjs"], {
    cwd: PKG_DIR,
    env: { PATH: process.env.PATH, REACH_PROFILE_FILE: fx.profileFile, REACH_DATA_DIR: fx.dataDir, REACH_ENV_FILE: fx.envFile },
    encoding: "utf8",
  });
  assert.equal(res.status, 1);
  assert.ok(res.stdout.includes("Usage: reach"));
});

test("11. migrate applies then is idempotent", async () => {
  const fx = fixture();
  const cap = () => { let out = ""; return { stdout: { write: (s) => { out += String(s); } }, text: () => out }; };
  const c1 = cap();
  const r1 = await runReachCli(["migrate"], { stdout: c1.stdout, ...fx });
  assert.equal(r1, 0);
  assert.ok(/applied.*1|migrated/i.test(c1.text()), c1.text());
  const c2 = cap();
  const r2 = await runReachCli(["migrate"], { stdout: c2.stdout, ...fx });
  assert.equal(r2, 0);
  assert.ok(/already/i.test(c2.text()), c2.text());
});
