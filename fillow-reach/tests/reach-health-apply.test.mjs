import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { healthGuard } from "../lib/reach/caps.mjs";
import { effectiveLimits, assertSendAllowedHealthy } from "../lib/reach/health-apply.mjs";
import { upsertCompany, upsertPerson } from "../lib/reach/people.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reach-health-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, `reach:
  enabled: true
  limits:
    invites_per_day: 4
    invites_per_7d: 75
    emails_per_day: 15
    linkedin_messages_per_7d: 75
  health:
    min_acceptance: 0.25
    max_bounce: 0.03
`, "utf8");
  writeFileSync(envFile, "", "utf8");
  return { profileFile, envFile, dataDir: join(dir, "data") };
}

function addInvite(db, { accepted = false, sentAt = "datetime('now','-2 days')" } = {}) {
  const n = db.prepare("SELECT COUNT(*) AS n FROM person").get().n;
  const companyId = upsertCompany(db, { name: "Acme" });
  const { personId } = upsertPerson(db, { full_name: `P${n}`, companyId, source: "manual" });
  db.prepare(
    `INSERT INTO connection (person_id, status, sent_via, sent_at, accepted_at) VALUES (?, ?, 'manual', ${sentAt}, ${accepted ? sentAt : "NULL"})`,
  ).run(personId, accepted ? "accepted" : "sent");
  return personId;
}

test("1. 1/5 accepts in 14d halves daily invite cap 4 → 2; third send throws", () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  addInvite(db, { accepted: true });
  for (let i = 0; i < 4; i += 1) addInvite(db);
  const h = healthGuard(db, cfg);
  assert.equal(h.halfTargets, true);
  assert.equal(effectiveLimits(db, cfg).invitesPerDay, 2);
  assert.equal(effectiveLimits(db, cfg).invitesPer7d, 75);
  addInvite(db, { sentAt: "datetime('now')" });
  addInvite(db, { sentAt: "datetime('now')" });
  assert.throws(
    () => assertSendAllowedHealthy({ db, reachCfg: cfg, action: "invite" }),
    /cap reached/,
  );
  db.close();
});

test("2. bounce over 5% pauses email and still allows invites", () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  const companyId = upsertCompany(db, { name: "Acme" });
  const { personId } = upsertPerson(db, { full_name: "Mail Person", companyId, source: "manual" });
  for (let i = 0; i < 9; i += 1) {
    db.prepare(
      "INSERT INTO message (person_id, channel, direction, status, body, sent_at) VALUES (?, 'email', 'out', 'sent', 'hi', datetime('now'))",
    ).run(personId);
  }
  db.prepare(
    "INSERT INTO message (person_id, channel, direction, status, body, sent_at) VALUES (?, 'email', 'out', 'bounced', 'hi', datetime('now'))",
  ).run(personId);
  const h = healthGuard(db, cfg);
  assert.equal(h.emailPaused, true);
  assert.throws(
    () => assertSendAllowedHealthy({ db, reachCfg: cfg, action: "email" }),
    /health/,
  );
  assert.doesNotThrow(() => assertSendAllowedHealthy({ db, reachCfg: cfg, action: "invite" }));
  db.close();
});
