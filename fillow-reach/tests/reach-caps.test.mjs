import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openReachDb, migrateReachDb, usageSnapshot } from "../lib/reach/db.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";
import { checkCap, assertSendAllowed, healthGuard } from "../lib/reach/caps.mjs";

const FIXTURE_YAML = [
  "reach:",
  "  limits:",
  "    invites_per_day: 2",
  "    invites_per_7d: 3",
  "    linkedin_messages_per_7d: 1",
  "    emails_per_day: 2",
  "",
].join("\n");

function fixtureCfg(dir) {
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, FIXTURE_YAML, "utf8");
  writeFileSync(envFile, "", "utf8");
  return loadReachConfig({ profileFile, envFile, dataDir: join(dir, "data") });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "reach-caps-"));
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return { dir, db, cfg: fixtureCfg(dir) };
}

function addPerson(db, name = "Ada Lovelace") {
  return Number(
    db.prepare("INSERT INTO person (full_name, persona, source) VALUES (?, 'recruiter', 'manual')")
      .run(name).lastInsertRowid,
  );
}

function addInvite(db, { sentOffset, acceptedOffset = null } = {}) {
  const pid = addPerson(db);
  db.prepare(
    "INSERT INTO connection (person_id, status, sent_at, accepted_at) VALUES (?, ?, datetime('now', ?), ?)",
  ).run(
    pid,
    acceptedOffset ? "accepted" : "sent",
    sentOffset,
    acceptedOffset ? db.prepare("SELECT datetime('now', ?) AS ts").get(acceptedOffset).ts : null,
  );
  return pid;
}

function addMessage(db, { channel, status, sentOffset }) {
  const pid = addPerson(db);
  db.prepare(
    "INSERT INTO message (person_id, channel, direction, status, body, sent_at) VALUES (?, ?, 'out', ?, 'hi', datetime('now', ?))",
  ).run(pid, channel, status, sentOffset);
  return pid;
}

const rowCounts = (db) => ({
  connection: db.prepare("SELECT COUNT(*) AS n FROM connection").get().n,
  message: db.prepare("SELECT COUNT(*) AS n FROM message").get().n,
  person: db.prepare("SELECT COUNT(*) AS n FROM person").get().n,
});

test("1. zero cap violations: fresh db → all three actions ok", () => {
  const { db, cfg } = setup();
  for (const action of ["invite", "linkedin_message", "email"]) {
    const res = checkCap({ db, reachCfg: cfg, action });
    assert.equal(res.ok, true, `${action} should be allowed on a fresh db`);
    assert.equal(res.blockedBy, null);
    assert.equal(res.used, 0);
  }
  db.close();
});

test("2. rolling 24h invites: -25h row excluded from day; two inside → blockedBy day", () => {
  const { db, cfg } = setup();
  addInvite(db, { sentOffset: "-25 hours" });
  let res = checkCap({ db, reachCfg: cfg, action: "invite" });
  assert.equal(res.ok, true);
  assert.equal(res.used, 1, "-25h invite is outside the day window but still consumes the weekly budget");
  addInvite(db, { sentOffset: "-23 hours" });
  res = checkCap({ db, reachCfg: cfg, action: "invite" });
  assert.equal(res.ok, true, "day 1+1<=2 and week 2+1<=3 — still allowed");
  addInvite(db, { sentOffset: "-22 hours" });
  res = checkCap({ db, reachCfg: cfg, action: "invite" });
  assert.equal(res.ok, false);
  assert.equal(res.blockedBy, "day");
  assert.equal(res.used, 2);
  assert.equal(res.cap, 2);
  db.close();
});

test("3. rolling 7d invites enforce even when the day has room", () => {
  const { db, cfg } = setup();
  for (const off of ["-5 days", "-4 days", "-3 days"]) addInvite(db, { sentOffset: off });
  const res = checkCap({ db, reachCfg: cfg, action: "invite" });
  assert.equal(res.ok, false);
  assert.equal(res.blockedBy, "week");
  assert.equal(res.used, 3);
  assert.equal(res.cap, 3);
  assert.equal(usageSnapshot(db).day.invite, 0);
  db.close();
});

test("4. an invite sent 8 days ago is excluded from the week window", () => {
  const { db, cfg } = setup();
  addInvite(db, { sentOffset: "-8 days" });
  addInvite(db, { sentOffset: "-8 days" });
  const res = checkCap({ db, reachCfg: cfg, action: "invite" });
  assert.equal(res.ok, true);
  assert.equal(res.used, 0);
  assert.equal(usageSnapshot(db).week.invite, 0);
  db.close();
});

test("5. linkedin_message: one sent within 7d hits cap 1; drafts never count", () => {
  const { db, cfg } = setup();
  addMessage(db, { channel: "linkedin", status: "draft", sentOffset: "-1 hours" });
  let res = checkCap({ db, reachCfg: cfg, action: "linkedin_message" });
  assert.equal(res.ok, true, "drafts must not consume the weekly budget");
  addMessage(db, { channel: "linkedin", status: "sent", sentOffset: "-1 hours" });
  res = checkCap({ db, reachCfg: cfg, action: "linkedin_message" });
  assert.equal(res.ok, false);
  assert.equal(res.blockedBy, "week");
  assert.equal(res.used, 1);
  assert.equal(res.cap, 1);
  db.close();
});

test("6. email day cap: 2 sent this day block; bounced does not count", () => {
  const { db, cfg } = setup();
  addMessage(db, { channel: "email", status: "bounced", sentOffset: "-1 hours" });
  let res = checkCap({ db, reachCfg: cfg, action: "email" });
  assert.equal(res.ok, true, "bounced mail must not consume the daily budget");
  addMessage(db, { channel: "email", status: "sent", sentOffset: "-2 hours" });
  addMessage(db, { channel: "email", status: "sent", sentOffset: "-1 hours" });
  res = checkCap({ db, reachCfg: cfg, action: "email" });
  assert.equal(res.ok, false);
  assert.equal(res.blockedBy, "day");
  assert.equal(res.used, 2);
  db.close();
});

test("7. a blocked assertSendAllowed writes nothing", () => {
  const { db, cfg } = setup();
  addMessage(db, { channel: "email", status: "sent", sentOffset: "-2 hours" });
  addMessage(db, { channel: "email", status: "sent", sentOffset: "-1 hours" });
  const before = rowCounts(db);
  assert.throws(
    () => assertSendAllowed({ db, reachCfg: cfg, action: "email" }),
    /daily email cap reached: 2\/2 in the last 24h — items stay queued/,
  );
  assert.deepEqual(rowCounts(db), before);
  db.close();
});

test("8. assertSendAllowed checks the pause switch before caps", () => {
  const { db, cfg, dir } = setup();
  // caps are free on a fresh db — a throw here can only come from the pause check
  mkdirSync(cfg.paths.reachDir, { recursive: true });
  writeFileSync(cfg.paths.pausePath, "2026-10-02 halt\n", "utf8");
  assert.throws(
    () => assertSendAllowed({ db, reachCfg: cfg, action: "invite" }),
    /paused/i,
  );
  db.close();
});

test("9. healthGuard: acceptance/bounce rates, halfTargets, zero-invite nulls", () => {
  // 1 accepted of 2 sent in 14d → 0.5 → no throttle
  let { db, cfg } = setup();
  addInvite(db, { sentOffset: "-2 days", acceptedOffset: "-1 days" });
  addInvite(db, { sentOffset: "-3 days" });
  let h = healthGuard(db, cfg);
  assert.equal(h.acceptanceRate14d, 0.5);
  assert.equal(h.halfTargets, false);
  assert.equal(h.emailPaused, false);
  db.close();

  // 1 accepted of 5 sent → 0.2 < 0.25 → halfTargets
  ({ db, cfg } = setup());
  addInvite(db, { sentOffset: "-2 days", acceptedOffset: "-1 days" });
  for (let i = 0; i < 4; i++) addInvite(db, { sentOffset: "-3 days" });
  h = healthGuard(db, cfg);
  assert.ok(Math.abs(h.acceptanceRate14d - 0.2) < 1e-9);
  assert.equal(h.halfTargets, true);
  db.close();

  // zero invites → acceptanceRate14d null and no throttle
  ({ db, cfg } = setup());
  addMessage(db, { channel: "email", status: "sent", sentOffset: "-1 days" });
  h = healthGuard(db, cfg);
  assert.equal(h.acceptanceRate14d, null);
  assert.equal(h.halfTargets, false);
  assert.equal(h.emailPaused, false);
  db.close();

  // hard bounce > 5% → emailPaused even below halfTargets' own guardrails
  ({ db, cfg } = setup());
  for (let i = 0; i < 10; i++) addMessage(db, { channel: "email", status: "sent", sentOffset: "-1 days" });
  addMessage(db, { channel: "email", status: "bounced", sentOffset: "-1 days" });
  h = healthGuard(db, cfg);
  assert.ok(Math.abs(h.bounceRate14d - 1 / 11) < 1e-9);
  assert.equal(h.emailPaused, true);
  assert.equal(h.halfTargets, true);
  db.close();
});
