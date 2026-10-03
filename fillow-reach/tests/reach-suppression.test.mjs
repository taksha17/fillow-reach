import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openReachDb, migrateReachDb, openReachMigratedDb } from "../lib/reach/db.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";
import {
  upsertCompany, upsertPerson, addSuppression, isSuppressed, insertEmailAddress,
  forgetPerson, purgeExpired,
} from "../lib/reach/people.mjs";
import { detectAcceptances } from "../lib/reach/acceptance.mjs";
import { enrichEmail } from "../lib/reach/provider-hunter.mjs";
import { runReachCli } from "../lib/reach/cli.mjs";

function mem() {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return db;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reach-sup-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, "reach:\n  enabled: true\n", "utf8");
  writeFileSync(envFile, "HUNTER_API_KEY=k\n", "utf8");
  return { profileFile, envFile, dataDir: join(dir, "data") };
}

test("1. suppressed email never enters email_address from Hunter", async () => {
  const db = mem();
  const companyId = upsertCompany(db, { name: "Acme", domain: "acme.com" });
  const { personId } = upsertPerson(db, { full_name: "Jane Doe", companyId, source: "manual" });
  addSuppression(db, { kind: "email", value: "jane@acme.com", reason: "manual" });
  const reachCfg = {
    enrichment: { order: ["hunter"], monthlyQuota: { hunter: 10 }, hunterKey: "k" },
    email: { requireVerified: true },
  };
  await enrichEmail(db, reachCfg, personId, {
    cooldown: new Set(),
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { email: "jane@acme.com", result: "valid", score: 99 } }),
    }),
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM email_address").get().n, 0);
  db.close();
});

test("2. suppressed linkedin_url blocks acceptance flip", () => {
  const db = mem();
  const companyId = upsertCompany(db, { name: "X Corp" });
  const { personId } = upsertPerson(db, {
    full_name: "Ada Lovelace", companyId, source: "manual",
    linkedin_url: "https://linkedin.com/in/adalovelace",
  });
  db.prepare("INSERT INTO connection (person_id, status) VALUES (?, 'sent')").run(personId);
  addSuppression(db, { kind: "linkedin_url", value: "linkedin.com/in/adalovelace", reason: "manual" });
  const r = detectAcceptances(db, {}, {
    fetcher: () => [{ subject: "Ada Lovelace has accepted your invitation", body: "Ada Lovelace has accepted your invitation." }],
  });
  assert.equal(r.accepted, 0);
  const c = db.prepare("SELECT status FROM connection WHERE person_id = ?").get(personId);
  assert.equal(c.status, "sent");
  const ev = db.prepare("SELECT action FROM event_log WHERE action = 'suppressed_blocked'").all();
  assert.ok(ev.length >= 1);
  db.close();
});

test("3. forgetPerson removes person; event_log remains with redacted person details", () => {
  const db = mem();
  const companyId = upsertCompany(db, { name: "Acme" });
  const { personId } = upsertPerson(db, { full_name: "Jane Doe", companyId, source: "manual" });
  db.prepare("INSERT INTO connection (person_id, status) VALUES (?, 'queued')").run(personId);
  const beforeEvents = db.prepare("SELECT COUNT(*) AS n FROM event_log").get().n;
  const r = forgetPerson(db, personId);
  assert.equal(r.ok, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connection").get().n, 0);
  const afterEvents = db.prepare("SELECT COUNT(*) AS n FROM event_log").get().n;
  assert.ok(afterEvents >= beforeEvents);
  const details = db.prepare("SELECT detail FROM event_log WHERE entity = 'person' AND entity_id = ?").all(personId);
  for (const row of details) {
    const d = JSON.parse(row.detail);
    assert.equal(d.redacted, true);
  }
  db.close();
});

test("4. purgeExpired closes old closed persons only", () => {
  const db = mem();
  const companyId = upsertCompany(db, { name: "Acme" });
  const oldP = upsertPerson(db, { full_name: "Old Closed", companyId, source: "manual" });
  const newP = upsertPerson(db, { full_name: "New Closed", companyId, source: "manual" });
  db.prepare("UPDATE person SET lifecycle = 'closed', updated_at = datetime('now','-181 days') WHERE id = ?").run(oldP.personId);
  db.prepare("UPDATE person SET lifecycle = 'closed', updated_at = datetime('now') WHERE id = ?").run(newP.personId);
  const r = purgeExpired(db, 180);
  assert.equal(r.purged, 1);
  assert.equal(db.prepare("SELECT full_name FROM person").get().full_name, "New Closed");
  db.close();
});

test("5. CLI suppress then isSuppressed", async () => {
  const fx = fixture();
  const cap = { text: "", write(s) { this.text += s; } };
  const code = await runReachCli(["suppress", "ada@x.test"], { stdout: cap, ...fx });
  assert.equal(code, 0, cap.text);
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  assert.equal(isSuppressed(db, { email: "ada@x.test" }), true);
  db.close();
});
