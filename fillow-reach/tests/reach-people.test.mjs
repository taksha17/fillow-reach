import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachMigratedDb, recordEvent } from "../lib/reach/db.mjs";
import {
  normalizeLinkedinUrl,
  normalizeCompanyName,
  upsertCompany,
  upsertPerson,
  addSuppression,
  isSuppressed,
} from "../lib/reach/people.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reach-people-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, "reach:\n  enabled: true\n", "utf8");
  writeFileSync(envFile, "", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir });
  const db = openReachMigratedDb(cfg);
  return { db, dir };
}

test("normalizeLinkedinUrl strips protocol, www, query, trailing slash; empty -> null", () => {
  assert.equal(normalizeLinkedinUrl("https://www.LinkedIn.com/in/JaneDoe?trk=xyz"), "linkedin.com/in/janedoe");
  assert.equal(normalizeLinkedinUrl("linkedin.com/in/jane-doe/"), "linkedin.com/in/jane-doe");
  assert.equal(normalizeLinkedinUrl(""), null);
  assert.equal(normalizeLinkedinUrl(null), null);
});

test("normalizeCompanyName lowercases, strips punctuation and legal suffixes", () => {
  assert.equal(normalizeCompanyName("Acme, Inc."), "acme");
  assert.equal(normalizeCompanyName("ACME"), "acme");
  assert.equal(normalizeCompanyName("Foo Bar LLC"), "foo bar");
});

test("1. upsertCompany('Acme Inc') then 'ACME' dedup to one row / same id", () => {
  const { db } = fixture();
  const a = upsertCompany(db, { name: "Acme Inc" });
  const b = upsertCompany(db, { name: "ACME" });
  assert.equal(a, b);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM company").get().n, 1);
  db.close();
});

test("2. upsertPerson same linkedin_url different casing -> one row, created=false", () => {
  const { db } = fixture();
  const first = upsertPerson(db, { full_name: "Jane Doe", companyId: null, linkedin_url: "https://www.linkedin.com/in/JaneDoe", source: "paste_import", persona: "recruiter" });
  const second = upsertPerson(db, { full_name: "Jane Doe", companyId: null, linkedin_url: "https://www.linkedin.com/in/janedoe/", source: "paste_import", persona: "recruiter" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.personId, second.personId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 1);
  db.close();
});

test("3. fuzzy dedup: 'Jane  Doe' @ 'acme inc' matches 'Jane Doe' @ Acme", () => {
  const { db } = fixture();
  const companyId = upsertCompany(db, { name: "Acme Inc" });
  const first = upsertPerson(db, { full_name: "Jane Doe", companyId, source: "paste_import" });
  const second = upsertPerson(db, { full_name: "Jane  Doe", companyId, source: "public_page" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.personId, second.personId);
  db.close();
});

test("4. suppressed company domain blocks upsert -> null + suppressed_blocked event", () => {
  const { db } = fixture();
  const companyId = upsertCompany(db, { name: "Acme Inc", domain: "acme.com" });
  addSuppression(db, { kind: "domain", value: "acme.com", reason: "manual" });
  const res = upsertPerson(db, { full_name: "Ada Lovelace", companyId, linkedin_url: "linkedin.com/in/ada-acme", source: "paste_import" });
  assert.equal(res, null);
  const ev = db.prepare("SELECT detail FROM event_log WHERE action='suppressed_blocked'").get();
  assert.ok(ev, "suppressed_blocked event missing");
  db.close();
});

test("5. addSuppression normalizes value and isSuppressed matches all kinds", () => {
  const { db } = fixture();
  addSuppression(db, { kind: "email", value: "Ada@X.test", reason: "manual" });
  addSuppression(db, { kind: "linkedin_url", value: "https://www.linkedin.com/in/janedoe/", reason: "manual" });
  assert.equal(isSuppressed(db, { email: "ada@x.test" }), true);
  assert.equal(isSuppressed(db, { linkedin_url: "linkedin.com/in/janedoe" }), true);
  assert.equal(isSuppressed(db, { email: "other@x.test" }), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM suppression").get().n, 2);
  db.close();
});

test("6. upsertPerson stores relevance_score and reasons JSON, splits names", () => {
  const { db } = fixture();
  const { personId } = upsertPerson(db, {
    full_name: "Grace Hopper", companyId: null, source: "paste_import", persona: "hiring_manager",
    relevance_score: 85, relevance_reasons: JSON.stringify(["persona:hiring_manager", "live-target"]),
  });
  const row = db.prepare("SELECT first_name, last_name, relevance_score, relevance_reasons, lifecycle FROM person WHERE id=?").get(personId);
  assert.deepEqual([row.first_name, row.last_name], ["Grace", "Hopper"]);
  assert.equal(row.relevance_score, 85);
  assert.deepEqual(JSON.parse(row.relevance_reasons), ["persona:hiring_manager", "live-target"]);
  assert.equal(row.lifecycle, "prospect");
  db.close();
});

test("7. recordEvent accepts agent used by M2 flows (prospect)", () => {
  const { db } = fixture();
  const id = recordEvent(db, { agent: "prospect", entity: "person", entityId: 1, action: "smoke", detail: {} });
  assert.ok(id > 0);
  db.close();
});
