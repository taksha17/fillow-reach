import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openReachDb, migrateReachDb, openReachMigratedDb } from "../lib/reach/db.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";
import { addSuppression } from "../lib/reach/people.mjs";
import { parseConnectionsCsv, importConnectionsCsv } from "../lib/reach/import-connections.mjs";
import { runReachCli } from "../lib/reach/cli.mjs";

function mem() {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return db;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reach-csv-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, "", "utf8");
  writeFileSync(envFile, "", "utf8");
  return { profileFile, envFile, dataDir, dir };
}

const SAMPLE = "\uFEFFLast Name,First Name,Company,Position,URL,Email Address\n"
  + "Doe,Jane,\"Acme, Inc\",Engineer,https://www.linkedin.com/in/JaneDoe,jane@acme.com\n";

test("1. parse BOM + reordered headers + quoted comma company", () => {
  const rows = parseConnectionsCsv(SAMPLE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].first, "Jane");
  assert.equal(rows[0].last, "Doe");
  assert.equal(rows[0].full_name, "Jane Doe");
  assert.equal(rows[0].company, "Acme, Inc");
  assert.equal(rows[0].title, "Engineer");
  assert.match(rows[0].linkedin_url, /JaneDoe/i);
  assert.equal(rows[0].email, "jane@acme.com");
});

test("2. apply:false writes nothing", () => {
  const db = mem();
  const r = importConnectionsCsv(db, SAMPLE, { apply: false });
  assert.equal(r.imported, 0);
  assert.equal(r.parsed, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  db.close();
});

test("3. apply:true sets connected + already_connected", () => {
  const db = mem();
  const r = importConnectionsCsv(db, SAMPLE, { apply: true });
  assert.equal(r.imported, 1);
  const p = db.prepare("SELECT lifecycle FROM person").get();
  assert.equal(p.lifecycle, "connected");
  const c = db.prepare("SELECT status, accepted_via FROM connection").get();
  assert.equal(c.status, "already_connected");
  assert.equal(c.accepted_via, "csv_import");
  db.close();
});

test("4. suppressed email is skipped", () => {
  const db = mem();
  addSuppression(db, { kind: "email", value: "jane@acme.com", reason: "manual" });
  const r = importConnectionsCsv(db, SAMPLE, { apply: true });
  assert.equal(r.imported, 0);
  assert.equal(r.skipped, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  db.close();
});

test("5. CLI without --yes writes nothing; with --yes imports", async () => {
  const fx = fixture();
  const csvPath = join(fx.dir, "connections.csv");
  writeFileSync(csvPath, SAMPLE, "utf8");
  const cap = { text: "", write(s) { this.text += s; } };
  const code = await runReachCli(["import", csvPath], { stdout: cap, ...fx });
  assert.equal(code, 0);
  assert.match(cap.text, /not written/i);
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  db.close();

  const cap2 = { text: "", write(s) { this.text += s; } };
  const code2 = await runReachCli(["import", "--yes", csvPath], { stdout: cap2, ...fx });
  assert.equal(code2, 0);
  const db2 = openReachMigratedDb(cfg);
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM person").get().n, 1);
  db2.close();
});
