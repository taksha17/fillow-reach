import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openReachDb, migrateReachDb, openReachMigratedDb } from "../lib/reach/db.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";
import { approveAllGrounded, approveDraft, listPendingApproval, preview } from "../lib/reach/send.mjs";
import { runReachCli } from "../lib/reach/cli.mjs";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "reach-approve-"));
  const profileFile = join(dir, "profile.yaml");
  writeFileSync(profileFile, "reach:\n  approval_mode: review\n", "utf8");
  writeFileSync(join(dir, ".env"), "", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile: join(dir, ".env"), dataDir: join(dir, "data") });
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return { dir, db, cfg };
}

function addPerson(db, name = "Dana Ruiz") {
  return Number(db.prepare("INSERT INTO person (full_name, persona, source) VALUES (?, 'recruiter', 'manual')")
    .run(name).lastInsertRowid);
}

function addDraft(db, { grounding, personId = null, body = "Hi Dana" } = {}) {
  const pid = personId ?? addPerson(db);
  const id = Number(db.prepare(
    "INSERT INTO message (person_id, channel, direction, step, status, body, grounding_ok, grounding_notes)"
    + " VALUES (?, 'email', 'out', 1, 'needs_approval', ?, ?, ?)",
  ).run(pid, body, grounding, grounding === 0 ? "unverified claim: Stripe" : null).lastInsertRowid);
  return id;
}

test("1. approveDraft promotes a grounded draft and records who/when", () => {
  const { db } = setup();
  const id = addDraft(db, { grounding: 1 });
  const r = approveDraft(db, id);
  assert.equal(r.ok, true);
  const row = db.prepare("SELECT status, approved_by, approved_at FROM message WHERE id = ?").get(id);
  assert.equal(row.status, "approved");
  assert.equal(row.approved_by, "user");
  assert.ok(row.approved_at, "approved_at is stamped");
  const ev = db.prepare("SELECT agent, action FROM event_log WHERE entity_id = ? AND action = 'draft_approved'").get(id);
  assert.equal(ev.agent, "outreach");
  db.close();
});

test("2. a grounding_ok=0 draft can never be approved", () => {
  const { db } = setup();
  const id = addDraft(db, { grounding: 0 });
  assert.throws(() => approveDraft(db, id), /failed grounding/);
  assert.throws(() => approveDraft(db, id), /unverified claim: Stripe/, "the reason is surfaced");
  const row = db.prepare("SELECT status FROM message WHERE id = ?").get(id);
  assert.equal(row.status, "needs_approval", "a refused approval changes nothing");
  db.close();
});

test("3. an ungrounded draft is refused too — approvals never skip the check", () => {
  const { db } = setup();
  const id = addDraft(db, { grounding: null });
  assert.throws(() => approveDraft(db, id), /never grounded/);
  db.close();
});

test("4. approveDraft rejects unknown, non-pending, and inbound messages", () => {
  const { db } = setup();
  assert.throws(() => approveDraft(db, 4242), /no message 4242/);
  const id = addDraft(db, { grounding: 1 });
  approveDraft(db, id);
  assert.throws(() => approveDraft(db, id), /is approved, not needs_approval/);
  const pid = addPerson(db, "Inbound Person");
  const inId = Number(db.prepare(
    "INSERT INTO message (person_id, channel, direction, status, body) VALUES (?, 'email', 'in', 'replied', 'thanks')",
  ).run(pid).lastInsertRowid);
  assert.throws(() => approveDraft(db, inId), /is inbound/);
  db.close();
});

test("5. approveAllGrounded approves only the grounded rows", () => {
  const { db } = setup();
  const ok1 = addDraft(db, { grounding: 1, personId: addPerson(db, "A") });
  const bad = addDraft(db, { grounding: 0, personId: addPerson(db, "B") });
  const unset = addDraft(db, { grounding: null, personId: addPerson(db, "C") });
  const r = approveAllGrounded(db);
  assert.deepEqual(r.approved, [ok1]);
  assert.deepEqual(r.blocked, [bad, unset]);
  assert.equal(db.prepare("SELECT status FROM message WHERE id = ?").get(bad).status, "needs_approval");
  db.close();
});

test("6. listPendingApproval returns only needs_approval rows, newest last", () => {
  const { db } = setup();
  const a = addDraft(db, { grounding: 1 });
  addDraft(db, { grounding: 0, personId: addPerson(db, "B") });
  approveDraft(db, a);
  const pending = listPendingApproval(db);
  assert.equal(pending.length, 1, "approved rows leave the queue");
  assert.equal(pending[0].grounding_ok, 0);
  db.close();
});

test("7. preview truncates to 160 characters on a word-ish boundary", () => {
  assert.equal(preview({ body: "short body" }), "short body");
  const long = "word ".repeat(80);
  const p = preview({ body: long });
  assert.ok(p.length <= 160, `expected <=160, got ${p.length}`);
  assert.ok(p.endsWith("..."));
});

test("8. CLI approve lists pending drafts with a 160-char preview and exits 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-approve-cli-"));
  const profileFile = join(dir, "profile.yaml");
  writeFileSync(profileFile, "reach:\n  approval_mode: review\n", "utf8");
  writeFileSync(join(dir, ".env"), "", "utf8");
  const fx = { profileFile, envFile: join(dir, ".env"), dataDir: join(dir, "data") };
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  addDraft(db, { grounding: 1, body: "Hi Dana, I build Python ETL pipelines." });
  addDraft(db, { grounding: 0, personId: addPerson(db, "B"), body: "I led Series B at Stripe." });
  db.close();

  let out = "";
  let code = await runReachCli(["approve"], { stdout: { write: (s) => { out += s; } }, ...fx });
  assert.equal(code, 0);
  assert.match(out, /GROUNDING FAILED/);
  assert.match(out, /grounded/);
  assert.match(out, /Hi Dana, I build Python ETL pipelines\./);
  assert.match(out, /approve --all-grounded/);
});

test("9. CLI approve --all-grounded promotes the grounded row and reports the rest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-approve-cli2-"));
  const profileFile = join(dir, "profile.yaml");
  writeFileSync(profileFile, "reach:\n  approval_mode: review\n", "utf8");
  writeFileSync(join(dir, ".env"), "", "utf8");
  const fx = { profileFile, envFile: join(dir, ".env"), dataDir: join(dir, "data") };
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  const good = addDraft(db, { grounding: 1 });
  const bad = addDraft(db, { grounding: 0, personId: addPerson(db, "B") });
  db.close();

  let out = "";
  const code = await runReachCli(["approve", "--all-grounded"], { stdout: { write: (s) => { out += s; } }, ...fx });
  assert.equal(code, 0);
  assert.match(out, /approved 1 grounded draft/);

  const check = openReachMigratedDb(cfg);
  assert.equal(check.prepare("SELECT status FROM message WHERE id = ?").get(good).status, "approved");
  assert.equal(check.prepare("SELECT status FROM message WHERE id = ?").get(bad).status, "needs_approval");
  check.close();
});

test("10. CLI approve <id> on a grounding-failed draft exits 1 and changes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-approve-cli3-"));
  const profileFile = join(dir, "profile.yaml");
  writeFileSync(profileFile, "reach:\n  approval_mode: review\n", "utf8");
  writeFileSync(join(dir, ".env"), "", "utf8");
  const fx = { profileFile, envFile: join(dir, ".env"), dataDir: join(dir, "data") };
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  const bad = addDraft(db, { grounding: 0 });
  db.close();

  let out = "";
  const code = await runReachCli(["approve", String(bad)], { stdout: { write: (s) => { out += s; } }, ...fx });
  assert.equal(code, 1);
  assert.match(out, /failed grounding/);

  const check = openReachMigratedDb(cfg);
  assert.equal(check.prepare("SELECT status FROM message WHERE id = ?").get(bad).status, "needs_approval");
  check.close();
});

test("11. CLI approve --json emits machine-readable output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-approve-cli4-"));
  const profileFile = join(dir, "profile.yaml");
  writeFileSync(profileFile, "reach:\n  approval_mode: review\n", "utf8");
  writeFileSync(join(dir, ".env"), "", "utf8");
  const fx = { profileFile, envFile: join(dir, ".env"), dataDir: join(dir, "data") };
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  addDraft(db, { grounding: 1, body: "Hi Dana" });
  db.close();

  let out = "";
  await runReachCli(["approve", "--json"], { stdout: { write: (s) => { out += s; } }, ...fx });
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].preview, "Hi Dana");
});

test("12. approve is registered as a live command, not a planned one", async () => {
  let out = "";
  const code = await runReachCli(["help"], { stdout: { write: (s) => { out += s; } } });
  assert.equal(code, 0);
  assert.match(out, /reach approve\s+review drafts/);
  assert.doesNotMatch(out, /\(M2\+\) review drafts/);
});
