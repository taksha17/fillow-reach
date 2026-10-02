import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MIGRATIONS_DIR,
  openReachDb,
  migrateReachDb,
  openReachMigratedDb,
} from "../lib/reach/db.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";

const TABLES = [
  "schema_version", "company", "person", "target_role",
  "person_target", "connection", "email_address", "resume_asset", "template",
  "message", "provider_usage", "enrichment_cache", "suppression", "run",
  "report", "event_log",
];

// node:sqlite rows have a null prototype — spread them before deepEqual.
const plain = (rows) => rows.map((r) => ({ ...r }));

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("0. MIGRATIONS_DIR is the ./migrations/ URL of lib/reach", () => {
  assert.ok(MIGRATIONS_DIR instanceof URL);
  assert.match(MIGRATIONS_DIR.pathname, /lib\/reach\/migrations\/$/);
});

test("1. migrate on fresh :memory: applies 1 migration; second run applies none", () => {
  const db = openReachDb(":memory:");
  const first = migrateReachDb(db);
  assert.deepEqual(first, { applied: [1, 2] });
  const second = migrateReachDb(db);
  assert.deepEqual(second, { applied: [] });
  db.close();
});

test("1b. migrated :memory: has all 16 tables", () => {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const names = rows.map((r) => r.name).sort();
  assert.deepEqual(names, [...TABLES].sort());
  db.close();
});

test("2. views v_usage_7d and v_usage_1d selectable; triggers present", () => {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  const v7 = plain(db.prepare("SELECT action, used FROM v_usage_7d ORDER BY action").all());
  assert.deepEqual(v7, [
    { action: "email", used: 0 },
    { action: "invite", used: 0 },
    { action: "linkedin_message", used: 0 },
  ]);
  const v1 = plain(db.prepare("SELECT action, used FROM v_usage_1d ORDER BY action").all());
  assert.deepEqual(v1, [
    { action: "email", used: 0 },
    { action: "invite", used: 0 },
    { action: "linkedin_message", used: 0 },
  ]);
  const trig = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(trig, ["event_log_no_delete", "event_log_no_update"]);
  db.close();
});

test("3. foreign_keys=1 on reopened tmpfile db; person delete cascades connection", () => {
  const dir = tmpDir("reach-db-");
  const dbPath = join(dir, "reach.db");
  const setup = openReachDb(dbPath);
  migrateReachDb(setup);
  setup.exec("INSERT INTO person (full_name, persona, source) VALUES ('Ada Lovelace', 'recruiter', 'manual')");
  setup.exec("INSERT INTO connection (person_id, status) VALUES (1, 'queued')");
  setup.close();

  const db = openReachDb(dbPath);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  db.exec("DELETE FROM person WHERE id = 1");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connection").get().n, 0);
  db.close();
});

test("4. message CHECK rejects channel 'sms'", () => {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  db.exec("INSERT INTO person (full_name, persona, source) VALUES ('Ada Lovelace', 'recruiter', 'manual')");
  assert.throws(() => {
    db.prepare("INSERT INTO message (person_id, channel, status, body) VALUES (1, 'sms', 'draft', 'hi')").run();
  }, /CHECK/i);
  db.close();
});

test("5. suppression UNIQUE(kind, value) rejects duplicates", () => {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  db.exec("INSERT INTO suppression (kind, value, reason) VALUES ('email', 'x@y.z', 'optout')");
  assert.throws(() => {
    db.prepare("INSERT INTO suppression (kind, value, reason) VALUES ('email', 'x@y.z', 'manual')").run();
  }, /UNIQUE/i);
  db.close();
});

test("6. openReachDb creates missing dirs + file; migrate records schema_version 1 and 2", () => {
  const dir = tmpDir("reach-db-");
  const dbPath = join(dir, "sub", "dir", "reach.db");
  const db = openReachDb(dbPath);
  assert.equal(existsSync(dbPath), true);
  migrateReachDb(db);
  assert.deepEqual(
    db.prepare("SELECT version FROM schema_version ORDER BY version").all().map((r) => r.version),
    [1, 2],
  );
  db.close();
});

test("7. openReachMigratedDb(reachCfg) migrates cfg.paths.dbPath", () => {
  const dir = tmpDir("reach-db-");
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, "candidate: {}\n", "utf8");
  writeFileSync(envFile, "", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir });
  const db = openReachMigratedDb(cfg);
  assert.equal(existsSync(cfg.paths.dbPath), true);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name),
    [...TABLES].sort(),
  );
  db.close();
});
