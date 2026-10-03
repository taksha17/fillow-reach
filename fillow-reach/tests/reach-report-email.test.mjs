import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openReachDb, migrateReachDb, openReachMigratedDb } from "../lib/reach/db.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";
import { upsertCompany, upsertPerson, insertEmailAddress } from "../lib/reach/people.mjs";
import { reportDate, buildDailyReport, renderReportText, sendDailyReport } from "../lib/reach/report.mjs";
import { runReachCli } from "../lib/reach/cli.mjs";

function mem() {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return db;
}

function fixture({ dryRun = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reach-report-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, `reach:\n  enabled: true\n  dry_run: ${dryRun}\n`, "utf8");
  writeFileSync(envFile, "", "utf8");
  return { profileFile, envFile, dataDir: join(dir, "data") };
}

function cfgOf(db) {
  return {
    limits: { invitesPerDay: 15, invitesPer7d: 75, linkedinMessagesPer7d: 75, emailsPerDay: 15 },
    health: { minAcceptance: 0.25, maxBounce: 0.03 },
    report: { time: "18:30", timezone: "America/Chicago", attachResumes: true },
    mail: { user: "me@example.com" },
    paths: { eventsDir: "/tmp", dbPath: ":memory:" },
  };
}

function seedSentToday(db) {
  const companyId = upsertCompany(db, { name: "Acme" });
  const { personId } = upsertPerson(db, {
    full_name: "Ada Lovelace", title: "Recruiter", companyId, source: "manual",
  });
  db.prepare(
    "INSERT INTO connection (person_id, status, sent_via, sent_at) VALUES (?, 'sent', 'manual', datetime('now'))",
  ).run(personId);
  db.prepare("UPDATE person SET lifecycle = 'invited' WHERE id = ?").run(personId);
  insertEmailAddress(db, { person_id: personId, email: "ada@acme.test", source: "manual", verification: "valid" });
  db.prepare(
    "INSERT INTO message (person_id, channel, direction, status, body, sent_at) VALUES (?, 'linkedin', 'out', 'sent', 'Hello Ada, circling a role.', datetime('now'))",
  ).run(personId);
  return personId;
}

test("1. reportDate pins America/Chicago calendar date", () => {
  assert.equal(reportDate(new Date("2026-10-03T04:59:00Z"), "America/Chicago"), "2026-10-02");
  assert.equal(reportDate(new Date("2026-10-03T05:01:00Z"), "America/Chicago"), "2026-10-03");
});

test("2. one LinkedIn sent today yields one row and header caps", () => {
  const db = mem();
  seedSentToday(db);
  const built = buildDailyReport(db, cfgOf(db), { date: new Date().toISOString().slice(0, 10) });
  assert.equal(built.rows.length, 1);
  assert.equal(built.rows[0].name, "Ada Lovelace");
  assert.match(built.rows[0].company, /Acme/i);
  assert.match(String(built.header.invites), /\/15|1\/15|0\/15/);
  const text = renderReportText(built);
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /15/);
  db.close();
});

test("3. dryRun does not call sendMailImpl", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  seedSentToday(db);
  let called = 0;
  const r = await sendDailyReport(db, cfg, {
    sendMailImpl: async () => { called += 1; },
    now: new Date(),
    dryRun: true,
  });
  assert.equal(called, 0);
  assert.equal(r.status, "built");
  const row = db.prepare("SELECT status FROM report").get();
  assert.equal(row.status, "built");
  db.close();
});

test("4. missing resume pdf is skipped and email still sends", async () => {
  const fx = fixture({ dryRun: false });
  const cfg = loadReachConfig(fx);
  cfg.report.attachResumes = true;
  const db = openReachMigratedDb(cfg);
  const personId = seedSentToday(db);
  db.prepare("INSERT INTO resume_asset (path, sha256) VALUES (?, 'abc')").run("/no/such/resume.pdf");
  const assetId = db.prepare("SELECT id FROM resume_asset").get().id;
  db.prepare(
    "INSERT INTO message (person_id, channel, direction, status, body, sent_at, resume_asset_id) VALUES (?, 'email', 'out', 'sent', 'cv attached', datetime('now'), ?)",
  ).run(personId, assetId);
  let sent = null;
  await sendDailyReport(db, { ...cfg, dryRun: false }, {
    sendMailImpl: async (mail) => { sent = mail; },
    now: new Date(),
    dryRun: false,
  });
  assert.ok(sent);
  assert.equal((sent.attachments ?? []).length, 0);
  const row = db.prepare("SELECT status FROM report").get();
  assert.equal(row.status, "sent");
  db.close();
});

test("5. CLI report prints the digest, exit 0", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  seedSentToday(db);
  db.close();
  let out = "";
  const code = await runReachCli(["report"], { stdout: { write: (s) => { out += s; } }, ...fx });
  assert.equal(code, 0, out);
  assert.match(out, /Ada Lovelace|invites|15/);
});
