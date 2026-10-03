import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openReachMigratedDb, recordEvent } from "../lib/reach/db.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";
import { exportEventsJsonl } from "../lib/reach/export-jsonl.mjs";
import { run as runReport } from "../agents/reach-report.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reach-jsonl-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, "reach:\n  enabled: true\n", "utf8");
  writeFileSync(envFile, "", "utf8");
  return { profileFile, envFile, dataDir: join(dir, "data") };
}

test("1. two events on a UTC date write two jsonl lines", () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  recordEvent(db, { agent: "report", entity: "system", action: "a", ts: "2026-10-02T10:00:00Z", detail: { n: 1 } });
  recordEvent(db, { agent: "report", entity: "system", action: "b", ts: "2026-10-02T11:00:00Z", detail: { n: 2 } });
  recordEvent(db, { agent: "report", entity: "system", action: "other-day", ts: "2026-10-01T10:00:00Z" });
  const r = exportEventsJsonl(db, cfg, { date: "2026-10-02" });
  assert.equal(r.written, 2);
  assert.equal(r.path, join(cfg.paths.eventsDir, "events-2026-10-02.jsonl"));
  const lines = readFileSync(r.path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.action, "a");
  assert.deepEqual(first.detail, { n: 1 });
  assert.ok("id" in first && "ts" in first && "agent" in first && "entity" in first);
  db.close();
});

test("2. second export appends only new ids; first line bytes unchanged", () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  recordEvent(db, { agent: "report", entity: "system", action: "a", ts: "2026-10-02T10:00:00Z" });
  recordEvent(db, { agent: "report", entity: "system", action: "b", ts: "2026-10-02T11:00:00Z" });
  const first = exportEventsJsonl(db, cfg, { date: "2026-10-02" });
  const before = readFileSync(first.path);
  const firstLine = before.toString("utf8").split("\n")[0];
  recordEvent(db, { agent: "report", entity: "system", action: "c", ts: "2026-10-02T12:00:00Z" });
  const second = exportEventsJsonl(db, cfg, { date: "2026-10-02" });
  assert.equal(second.written, 1);
  const after = readFileSync(second.path);
  assert.equal(after.toString("utf8").split("\n")[0], firstLine);
  assert.equal(after.toString("utf8").trim().split("\n").length, 3);
  assert.deepEqual(before.subarray(0, firstLine.length), after.subarray(0, firstLine.length));
  db.close();
});

test("3. report agent run exports jsonl for the report date", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  recordEvent(db, { agent: "contacts", entity: "system", action: "seed", ts: "2026-10-02T18:00:00Z" });
  db.close();
  const out = await runReport(cfg, { now: new Date("2026-10-02T23:00:00Z") });
  const path = join(cfg.paths.eventsDir, `events-${out.date}.jsonl`);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.ok(lines.length >= 1);
});
