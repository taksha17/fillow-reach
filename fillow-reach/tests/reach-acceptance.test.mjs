import test from "node:test";
import assert from "node:assert/strict";

import { openReachDb, migrateReachDb } from "../lib/reach/db.mjs";
import { upsertCompany, upsertPerson, insertEmailAddress } from "../lib/reach/people.mjs";
import { parseAcceptance, detectAcceptances, parseBounce, detectBounces } from "../lib/reach/acceptance.mjs";

function mem() {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return db;
}

function seedAda(db, companyName, { status = "sent" } = {}) {
  const companyId = upsertCompany(db, { name: companyName });
  const { personId } = upsertPerson(db, { full_name: "Ada Lovelace", companyId, source: "manual" });
  db.prepare("INSERT INTO connection (person_id, status) VALUES (?, ?)").run(personId, status);
  return { personId, companyId };
}

test("1. unique match flips to accepted", () => {
  const db = mem();
  const { personId } = seedAda(db, "X Corp");
  const r = detectAcceptances(db, {}, {
    fetcher: () => [{ subject: "Ada Lovelace has accepted your invitation", body: "Ada Lovelace has accepted your invitation." }],
  });
  assert.equal(r.accepted, 1);
  const c = db.prepare("SELECT status, accepted_via FROM connection WHERE person_id = ?").get(personId);
  assert.equal(c.status, "accepted");
  assert.equal(c.accepted_via, "notification_email");
  db.close();
});

test("2. duplicate names at different companies do not flip", () => {
  const db = mem();
  seedAda(db, "X Corp");
  seedAda(db, "Y Corp");
  const r = detectAcceptances(db, {}, {
    fetcher: () => [{ subject: "Ada Lovelace has accepted your invitation", body: "Ada Lovelace has accepted your invitation." }],
  });
  assert.equal(r.accepted, 0);
  assert.equal(r.unmatched, 1);
  const n = db.prepare("SELECT COUNT(*) AS n FROM connection WHERE status = 'accepted'").get().n;
  assert.equal(n, 0);
  const ev = db.prepare("SELECT action FROM event_log WHERE action = 'acceptance_unmatched'").all();
  assert.equal(ev.length, 1);
  db.close();
});

test("3. already accepted is not double-logged", () => {
  const db = mem();
  seedAda(db, "X Corp", { status: "accepted" });
  db.prepare("UPDATE connection SET accepted_via = 'csv_import'").run();
  const before = db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'invite_accepted'").get().n;
  const r = detectAcceptances(db, {}, {
    fetcher: () => [{ subject: "Ada Lovelace has accepted your invitation", body: "Ada Lovelace has accepted your invitation." }],
  });
  assert.equal(r.accepted, 0);
  const after = db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE action = 'invite_accepted'").get().n;
  assert.equal(after, before);
  db.close();
});

test("4. QP-decoded body still parses", () => {
  const parsed = parseAcceptance({
    subject: "accepted your invitation",
    body: "Ada Lovelace has accepted your invitation.",
  });
  assert.equal(parsed.full_name, "Ada Lovelace");
});

test("5. hard bounce 550 invalidates and suppresses", () => {
  const db = mem();
  const { personId } = seedAda(db, "X Corp");
  insertEmailAddress(db, { person_id: personId, email: "ada@x.test", source: "manual", verification: "valid" });
  const r = detectBounces(db, {}, {
    fetcher: () => [{
      subject: "Mail delivery failed",
      body: "Status: 5.1.1\nFinal-Recipient: rfc822; ada@x.test\n550 User unknown",
    }],
  });
  assert.equal(r.hard, 1);
  const e = db.prepare("SELECT verification FROM email_address WHERE email = 'ada@x.test'").get();
  assert.equal(e.verification, "invalid");
  const s = db.prepare("SELECT reason FROM suppression WHERE value = 'ada@x.test'").get();
  assert.equal(s.reason, "bounce");
  db.close();
});

test("6. soft bounce 4.x does not change verification", () => {
  const db = mem();
  const { personId } = seedAda(db, "X Corp");
  insertEmailAddress(db, { person_id: personId, email: "ada@x.test", source: "manual", verification: "valid" });
  const r = detectBounces(db, {}, {
    fetcher: () => [{
      subject: "Delayed",
      body: "Status: 4.2.2\nFinal-Recipient: rfc822; ada@x.test",
    }],
  });
  assert.equal(r.soft, 1);
  const e = db.prepare("SELECT verification FROM email_address WHERE email = 'ada@x.test'").get();
  assert.equal(e.verification, "valid");
  const ev = db.prepare("SELECT action FROM event_log WHERE action = 'bounce_soft'").all();
  assert.equal(ev.length, 1);
  db.close();
});
