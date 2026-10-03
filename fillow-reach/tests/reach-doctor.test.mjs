import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectDoctorChecks } from "../lib/reach/doctor.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachDb, migrateReachDb } from "../lib/reach/db.mjs";
import { runReachCli } from "../lib/reach/cli.mjs";

function fixture(profileYaml = "reach:\n  enabled: true\n", envText = "") {
  const dir = mkdtempSync(join(tmpdir(), "reach-doctor-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, profileYaml, "utf8");
  writeFileSync(envFile, envText, "utf8");
  return { profileFile, envFile, dataDir };
}

function migrated(fx) {
  const cfg = loadReachConfig(fx);
  const db = openReachDb(cfg.paths.dbPath);
  migrateReachDb(db);
  db.close();
  return fx;
}

function find(rows, label) {
  const row = rows.find((r) => r.label === label);
  assert.ok(row, `expected a "${label}" row`);
  return row;
}

async function cli(argv, fx) {
  let out = "";
  const code = await runReachCli(argv, { stdout: { write: (s) => { out += String(s); } }, ...fx });
  return { code, out };
}

test("1. sane fixture: every row present, nothing failed", async () => {
  const fx = migrated(fixture("reach:\n  enabled: true\n", "REACH_MAIL_USER=u@example.com\nREACH_MAIL_PASSWORD=pw\nHUNTER_API_KEY=h\nAPOLLO_API_KEY=a\n"));
  const rows = await collectDoctorChecks({ ...fx, skipMail: true, whichBsk: () => false });
  assert.deepEqual(rows.map((r) => r.label), ["node", "node:sqlite", "config", "migrations", "mail creds", "hunter", "apollo", "imap", "bsk"]);
  assert.ok(rows.every((r) => r.ok), JSON.stringify(rows));
});

test("2. missing reach: block → fail row naming setup", async () => {
  const fx = fixture("candidate:\n  name: Jane Doe\n");
  const rows = await collectDoctorChecks({ ...fx, skipMail: true });
  const row = find(rows, "config");
  assert.equal(row.ok, false);
  assert.match(row.detail, /reach setup/);
});

test("3. invalid reach block → fail row naming the key", async () => {
  const fx = fixture("reach:\n  approval_mode: nope\n");
  const rows = await collectDoctorChecks({ ...fx, skipMail: true });
  const row = find(rows, "config");
  assert.equal(row.ok, false);
  assert.match(row.detail, /approval_mode/);
});

test("4. deleted schema_version row → pending-migration fail naming version 1", async () => {
  const fx = migrated(fixture());
  const cfg = loadReachConfig(fx);
  const db = openReachDb(cfg.paths.dbPath);
  db.prepare("DELETE FROM schema_version WHERE version = 1").run();
  db.close();
  const rows = await collectDoctorChecks({ ...fx, skipMail: true });
  const row = find(rows, "migrations");
  assert.equal(row.ok, false);
  assert.match(row.detail, /1/);
});

test("5. missing DB → fail row naming migrate", async () => {
  const fx = fixture();
  const rows = await collectDoctorChecks({ ...fx, skipMail: true });
  const row = find(rows, "migrations");
  assert.equal(row.ok, false);
  assert.match(row.detail, /migrate/);
});

test("6. no mail creds → warn (not fail) with app-password guidance; warn never flips exit", async () => {
  const fx = migrated(fixture("reach:\n  enabled: true\n"));
  const rows = await collectDoctorChecks({ ...fx, skipMail: true });
  const mail = find(rows, "mail creds");
  assert.equal(mail.ok, true);
  assert.equal(mail.warn, true);
  assert.match(mail.detail, /2-Step Verification/i);
  const { code } = await cli(["doctor", "--no-mail"], fx);
  assert.equal(code, 0);
});

test("7. enrichment keys absent → warn rows 'provider disabled — quota 0'", async () => {
  const fx = migrated(fixture());
  const rows = await collectDoctorChecks({ ...fx, skipMail: true });
  for (const label of ["hunter", "apollo"]) {
    const row = find(rows, label);
    assert.equal(row.warn, true);
    assert.match(row.detail, /provider disabled — quota 0/);
  }
});

test("8. skipMail → imap row ok with detail 'skipped'", async () => {
  const fx = migrated(fixture("reach:\n  enabled: true\n", "REACH_MAIL_USER=u@example.com\nREACH_MAIL_PASSWORD=pw\n"));
  const rows = await collectDoctorChecks({ ...fx, skipMail: true });
  assert.deepEqual(find(rows, "imap"), { ok: true, warn: false, label: "imap", detail: "skipped" });
});

test("9. enabled: false → warn row", async () => {
  const fx = migrated(fixture("reach:\n  enabled: false\n"));
  const rows = await collectDoctorChecks({ ...fx, skipMail: true });
  const row = find(rows, "enabled");
  assert.equal(row.warn, true);
  assert.match(row.detail, /set reach\.enabled: true/);
});

test("10. CLI doctor exit 1 when a row fails, even with other warn rows", async () => {
  const fx = fixture("reach:\n  approval_mode: nope\n");
  const { code, out } = await cli(["doctor", "--no-mail"], fx);
  assert.equal(code, 1);
  assert.match(out, /approval_mode/);
});

test("11. bsk binary missing is a warn, never a fail", async () => {
  const fx = migrated(fixture());
  const rows = await collectDoctorChecks({ ...fx, skipMail: true, whichBsk: () => false });
  const row = find(rows, "bsk");
  assert.equal(row.ok, true);
  assert.equal(row.warn, true);
  assert.match(row.detail, /bsk binary missing/);
});

test("12. send_mode bsk without BSK_ACK warns; does not fail", async () => {
  const fx = migrated(fixture("reach:\n  enabled: true\n  linkedin:\n    send_mode: bsk\n"));
  const rows = await collectDoctorChecks({ ...fx, skipMail: true, whichBsk: () => true });
  const row = find(rows, "bsk ack");
  assert.equal(row.ok, true);
  assert.equal(row.warn, true);
  assert.match(row.detail, /BSK_ACK/);
  const { code } = await cli(["doctor", "--no-mail"], fx);
  assert.equal(code, 0);
});

test("13. approval_mode sample is a warn note", async () => {
  const fx = migrated(fixture("reach:\n  enabled: true\n  approval_mode: sample\n"));
  const rows = await collectDoctorChecks({ ...fx, skipMail: true, whichBsk: () => true });
  const row = find(rows, "approval");
  assert.equal(row.ok, true);
  assert.equal(row.warn, true);
  assert.match(row.detail, /sample/);
});
