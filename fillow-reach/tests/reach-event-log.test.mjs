import test from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_ENTITIES,
  recordEvent,
  usageSnapshot,
  openReachDb,
  migrateReachDb,
} from "../lib/reach/db.mjs";

const plain = (rows) => rows.map((r) => ({ ...r }));

function freshDb() {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return db;
}

test("exports: EVENT_ENTITIES freezes the 6 PRD entity names", () => {
  assert.deepEqual(
    [...EVENT_ENTITIES].sort(),
    ["connection", "email_address", "message", "person", "run", "system"],
  );
  assert.ok(Object.isFrozen(EVENT_ENTITIES));
});

test("1. recordEvent inserts one row; supplied ts normalized to YYYY-MM-DD HH:MM:SS", () => {
  const db = freshDb();
  const id = recordEvent(db, {
    agent: "prospect",
    entity: "person",
    entityId: 42,
    action: "seeded",
    detail: { source: "apollo" },
    ts: "2026-09-30T23:59:59.123Z",
  });
  assert.equal(typeof id, "number");
  const rows = plain(db.prepare("SELECT * FROM event_log").all());
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, id);
  assert.match(row.ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(row.ts, "2026-09-30 23:59:59");
  assert.equal(row.run_id, null);
  assert.equal(row.agent, "prospect");
  assert.equal(row.entity, "person");
  assert.equal(row.entity_id, 42);
  assert.equal(row.action, "seeded");
  assert.deepEqual(JSON.parse(row.detail), { source: "apollo" });
  db.close();
});

test("2. UPDATE and DELETE on event_log throw append-only", () => {
  const db = freshDb();
  recordEvent(db, { agent: "prospect", entity: "system", action: "setup" });
  assert.throws(() => {
    db.prepare("UPDATE event_log SET action = 'tampered' WHERE id = 1").run();
  }, /append-only/);
  assert.throws(() => {
    db.prepare("DELETE FROM event_log").run();
  }, /append-only/);
  db.close();
});

test("3. recordEvent rejects entity outside EVENT_ENTITIES", () => {
  const db = freshDb();
  assert.throws(() => {
    recordEvent(db, { agent: "prospect", entity: "jobs", action: "x" });
  }, /entity/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM event_log").get().n, 0);
  db.close();
});

test("4. omitted ts falls back to the column DEFAULT datetime('now')", () => {
  const db = freshDb();
  recordEvent(db, { agent: "report", entity: "run", action: "finished" });
  const row = db.prepare("SELECT ts, detail, run_id, entity_id FROM event_log").get();
  assert.match(row.ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(JSON.parse(row.detail) && typeof JSON.parse(row.detail), "object");
  assert.equal(JSON.stringify(JSON.parse(row.detail)), "{}");
  db.close();
});

test("5. usageSnapshot reads v_usage_1d/v_usage_7d; SQL-side backdating pins DB clock", () => {
  const db = freshDb();
  db.exec("INSERT INTO person (full_name, persona, source) VALUES ('Ada Lovelace', 'recruiter', 'manual')");

  // empty snapshot: all zeros, all keys present
  let snap = usageSnapshot(db);
  assert.deepEqual(snap, {
    day: { invite: 0, linkedin_message: 0, email: 0 },
    week: { invite: 0, linkedin_message: 0, email: 0 },
  });

  // now: in both windows
  db.exec(
    "INSERT INTO message (person_id, channel, direction, status, body, sent_at) " +
    "VALUES (1, 'linkedin', 'out', 'sent', 'hi', datetime('now'))"
  );
  db.exec("INSERT INTO connection (person_id, status, sent_at) VALUES (1, 'sent', datetime('now'))");

  // -6 days: absent from day, present in week
  db.exec(
    "INSERT INTO message (person_id, channel, direction, status, body, sent_at) " +
    "VALUES (1, 'email', 'out', 'sent', 'hi', datetime('now','-6 days'))"
  );

  // -8 days: absent from both
  db.exec(
    "INSERT INTO message (person_id, channel, direction, status, body, sent_at) " +
    "VALUES (1, 'email', 'out', 'sent', 'hi', datetime('now','-8 days'))"
  );

  // drafts/non-out rows never count
  db.exec(
    "INSERT INTO message (person_id, channel, direction, status, body, sent_at) " +
    "VALUES (1, 'email', 'out', 'draft', 'hi', datetime('now'))"
  );

  snap = usageSnapshot(db);
  assert.deepEqual(snap, {
    day: { invite: 1, linkedin_message: 1, email: 0 },
    week: { invite: 1, linkedin_message: 1, email: 1 },
  });
  db.close();
});
