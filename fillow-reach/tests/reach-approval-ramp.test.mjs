import test from "node:test";
import assert from "node:assert/strict";

import { openReachDb, migrateReachDb } from "../lib/reach/db.mjs";
import { upsertCompany, upsertPerson } from "../lib/reach/people.mjs";
import {
  N_SAMPLE, N_AUTO, consecutiveCleanApprovals, autoApproveAllowed, maybeAutoApprove, noteDraftGrounding,
} from "../lib/reach/approval-ramp.mjs";

function mem() {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return db;
}

function person(db) {
  const companyId = upsertCompany(db, { name: "Acme" });
  return upsertPerson(db, { full_name: "Ada Lovelace", companyId, source: "manual" }).personId;
}

function approve(db, personId, { grounding = 1, by = "user", edited = false } = {}) {
  const r = db.prepare(
    "INSERT INTO message (person_id, channel, status, body, grounding_ok, approved_by, approved_at) VALUES (?, 'email', 'approved', 'hi', ?, ?, datetime('now'))",
  ).run(personId, grounding, by);
  if (edited) {
    db.prepare("INSERT INTO event_log (agent, entity, entity_id, action, detail) VALUES ('outreach', 'message', ?, 'draft_approved', ?)").run(
      r.lastInsertRowid, JSON.stringify({ edited: true }),
    );
  }
  return r.lastInsertRowid;
}

test("exports N_SAMPLE 5 and N_AUTO 10", () => {
  assert.equal(N_SAMPLE, 5);
  assert.equal(N_AUTO, 10);
});

test("1. review mode never auto", () => {
  const db = mem();
  const id = person(db);
  for (let i = 0; i < 12; i += 1) approve(db, id);
  const cfg = { approvalMode: "review" };
  assert.equal(autoApproveAllowed(cfg, db, { rngImpl: () => 0.9 }), false);
  db.close();
});

test("2. five clean user approvals in sample auto the sixth (rng 0.9 not audit)", async () => {
  const db = mem();
  const id = person(db);
  for (let i = 0; i < 5; i += 1) approve(db, id);
  assert.equal(consecutiveCleanApprovals(db), 5);
  const cfg = { approvalMode: "sample" };
  assert.equal(autoApproveAllowed(cfg, db, { rngImpl: () => 0.9 }), true);
  const draft = db.prepare(
    "INSERT INTO message (person_id, channel, status, body, grounding_ok) VALUES (?, 'email', 'needs_approval', 'next', 1)",
  ).run(id).lastInsertRowid;
  const r = maybeAutoApprove(db, cfg, draft, { rngImpl: () => 0.9 });
  assert.equal(r.status, "approved");
  const row = db.prepare("SELECT status, approved_by FROM message WHERE id = ?").get(draft);
  assert.equal(row.status, "approved");
  assert.equal(row.approved_by, "auto");
  const ev = db.prepare("SELECT action FROM event_log WHERE action = 'draft_auto_approved'").get();
  assert.equal(ev.action, "draft_auto_approved");
  db.close();
});

test("3. grounding_ok 0 blocks auto even in auto mode and records demotion", () => {
  const db = mem();
  const id = person(db);
  for (let i = 0; i < 10; i += 1) approve(db, id);
  const cfg = { approvalMode: "auto" };
  assert.equal(autoApproveAllowed(cfg, db), true);
  const draft = db.prepare(
    "INSERT INTO message (person_id, channel, status, body, grounding_ok) VALUES (?, 'email', 'needs_approval', 'bad', 0)",
  ).run(id).lastInsertRowid;
  noteDraftGrounding(db, draft, 0);
  assert.equal(autoApproveAllowed(cfg, db), false);
  const ev = db.prepare("SELECT action FROM event_log WHERE action = 'approval_demoted'").get();
  assert.equal(ev.action, "approval_demoted");
  db.close();
});

test("4. sample rng 0.05 stays needs_approval for audit", () => {
  const db = mem();
  const id = person(db);
  for (let i = 0; i < 5; i += 1) approve(db, id);
  const cfg = { approvalMode: "sample" };
  assert.equal(autoApproveAllowed(cfg, db, { rngImpl: () => 0.05 }), false);
  const draft = db.prepare(
    "INSERT INTO message (person_id, channel, status, body, grounding_ok) VALUES (?, 'email', 'needs_approval', 'audit', 1)",
  ).run(id).lastInsertRowid;
  const r = maybeAutoApprove(db, cfg, draft, { rngImpl: () => 0.05 });
  assert.equal(r.status, "needs_approval");
  const row = db.prepare("SELECT status, approved_by FROM message WHERE id = ?").get(draft);
  assert.equal(row.status, "needs_approval");
  assert.equal(row.approved_by, null);
  db.close();
});
