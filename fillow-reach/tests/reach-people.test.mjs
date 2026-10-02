import test from "node:test";
import assert from "node:assert/strict";

import { openReachDb, migrateReachDb } from "../lib/reach/db.mjs";
import {
  upsertCompany,
  upsertPerson,
  addSuppression,
  insertEmailAddress,
} from "../lib/reach/people.mjs";

function mem() {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return db;
}

test("1. upsertCompany Acme Inc then ACME shares an id", () => {
  const db = mem();
  const a = upsertCompany(db, { name: "Acme Inc" });
  const b = upsertCompany(db, { name: "ACME" });
  assert.equal(a, b);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM company").get().n, 1);
  db.close();
});

test("2. upsertPerson same linkedin_url different casing is one row", () => {
  const db = mem();
  const companyId = upsertCompany(db, { name: "Acme" });
  const first = upsertPerson(db, {
    full_name: "Jane Doe",
    companyId,
    linkedin_url: "https://www.LinkedIn.com/in/JaneDoe/",
    source: "manual",
  });
  const second = upsertPerson(db, {
    full_name: "Jane Doe",
    companyId,
    linkedin_url: "https://linkedin.com/in/janedoe",
    source: "manual",
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.personId, second.personId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 1);
  db.close();
});

test("3. fuzzy Jane Doe @ Acme vs Jane  Doe @ acme inc is one row", () => {
  const db = mem();
  const a = upsertCompany(db, { name: "Acme" });
  const b = upsertCompany(db, { name: "acme inc" });
  assert.equal(a, b);
  const first = upsertPerson(db, { full_name: "Jane Doe", companyId: a, source: "manual" });
  const second = upsertPerson(db, { full_name: "Jane  Doe", companyId: b, source: "manual" });
  assert.equal(second.created, false);
  assert.equal(first.personId, second.personId);
  db.close();
});

test("4. suppressed domain blocks upsertPerson", () => {
  const db = mem();
  addSuppression(db, { kind: "domain", value: "acme.com", reason: "manual" });
  const companyId = upsertCompany(db, { name: "Acme", domain: "acme.com" });
  const row = upsertPerson(db, {
    full_name: "Jane Doe",
    companyId,
    source: "manual",
  });
  assert.equal(row, null);
  const ev = db.prepare("SELECT action FROM event_log WHERE action = 'suppressed_blocked'").all();
  assert.equal(ev.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  db.close();
});

test("5. insertEmailAddress twice same person+email", () => {
  const db = mem();
  const companyId = upsertCompany(db, { name: "Acme" });
  const { personId } = upsertPerson(db, { full_name: "Jane Doe", companyId, source: "manual" });
  const a = insertEmailAddress(db, { person_id: personId, email: "jane@acme.com", source: "manual" });
  const b = insertEmailAddress(db, { person_id: personId, email: "Jane@Acme.com", source: "manual" });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.id, b.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM email_address").get().n, 1);
  db.close();
});

test("6. insertEmailAddress on suppressed email writes nothing", () => {
  const db = mem();
  const companyId = upsertCompany(db, { name: "Acme" });
  const { personId } = upsertPerson(db, { full_name: "Jane Doe", companyId, source: "manual" });
  addSuppression(db, { kind: "email", value: "jane@acme.com", reason: "optout" });
  const row = insertEmailAddress(db, { person_id: personId, email: "jane@acme.com", source: "manual" });
  assert.equal(row, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM email_address").get().n, 0);
  db.close();
});
