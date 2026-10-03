import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReachConfig, REACH_DEFAULTS } from "../lib/reach/config.mjs";
import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { upsertCompany, upsertPerson, addSuppression, normalizeCompanyName } from "../lib/reach/people.mjs";
import { syncTargets } from "../lib/reach/targets.mjs";
import { scorePerson } from "../lib/reach/score.mjs";
import { queueDaily } from "../lib/reach/queue.mjs";

function fixture(profileYaml = "reach:\n  enabled: true\n") {
  const dir = mkdtempSync(join(tmpdir(), "reach-queue-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, profileYaml, "utf8");
  writeFileSync(envFile, "", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir });
  const db = openReachMigratedDb(cfg);
  return { db, cfg, dir, profileFile, envFile, dataDir };
}

function addTargetCompany(db, cfg, { company = "Acme Inc", title = "Recruiter", ref = "greenhouse:g-1" } = {}) {
  syncTargets(db, cfg, { jobs: [{ source: ref.split(":")[0], external_id: ref.split(":")[1], title, company, status: "ready" }] });
  return db.prepare("SELECT id FROM company WHERE name_norm=?").get(normalizeCompanyName(company)).id;
}

function addProspect(db, { name, title = "Recruiter", persona = "recruiter", companyId = null, url = null }) {
  const res = upsertPerson(db, {
    full_name: name, title, companyId,
    linkedin_url: url ?? `linkedin.com/in/${name.toLowerCase().replace(/\s+/g, "-")}`,
    persona, source: "paste_import",
  });
  return res.personId;
}

test("scorePerson pins: persona +30, title-match +25, live-target +25, recent +10, seniority +10, clamp", () => {
  const s = scorePerson({ title: "Technical Recruiter", persona: "recruiter", companyIsTarget: true, recencyDays: 0, targetTitle: "Technical Recruiter" });
  assert.equal(s.score, 90); // 30 + 25 + 25 + 10
  assert.deepEqual(s.reasons, ["persona:recruiter", "title-match", "live-target", "recent"]);

  const exec = scorePerson({ title: "CEO", persona: "executive", companyIsTarget: false, recencyDays: null, targetTitle: "Engineer", personas: ["executive"] });
  assert.equal(exec.score, 30);
  assert.deepEqual(exec.reasons, ["persona:executive"]);

  const senior = scorePerson({ title: "Staff Engineer", persona: "senior_ic", companyIsTarget: false, recencyDays: null, targetTitle: "Staff Engineer" });
  assert.equal(senior.score, 65); // 30 + 25 + 10
  const clamped = scorePerson({ title: "x", persona: "recruiter", companyIsTarget: true, recencyDays: 0, targetTitle: "x" });
  assert.ok(clamped.score <= 100);
});

test("1. recruiter + live target + title match -> queued with score and reasons stored", () => {
  const { db, cfg } = fixture();
  const companyId = addTargetCompany(db, cfg, { title: "Technical Recruiter" });
  addProspect(db, { name: "Jane Doe", title: "Technical Recruiter", persona: "recruiter", companyId });
  const res = queueDaily(db, cfg);
  assert.equal(res.queued, 1);
  const row = db.prepare("SELECT relevance_score, relevance_reasons FROM person WHERE full_name='Jane Doe'").get();
  assert.ok(row.relevance_score >= 70);
  assert.ok(JSON.parse(row.relevance_reasons).includes("persona:recruiter"));
  assert.ok(JSON.parse(row.relevance_reasons).includes("live-target"));
  const conn = db.prepare("SELECT status FROM connection WHERE person_id=(SELECT id FROM person WHERE full_name='Jane Doe')").get();
  assert.equal(conn.status, "queued");
  const ev = db.prepare("SELECT detail FROM event_log WHERE action='invite_queued'").get();
  assert.ok(ev, "invite_queued event missing");
  db.close();
});

test("2. score below minRelevance 70 -> queued 0, person stays prospect", () => {
  const { db, cfg } = fixture();
  addProspect(db, { name: "Low Score", title: "Chef", persona: "other" });
  const res = queueDaily(db, cfg);
  assert.equal(res.queued, 0);
  assert.equal(res.considered, 0); // below-min is not part of the considered set
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connection").get().n, 0);
  assert.equal(db.prepare("SELECT lifecycle FROM person WHERE full_name='Low Score'").get().lifecycle, "prospect");
  db.close();
});

test("3. already_connected person skipped", () => {
  const { db, cfg } = fixture();
  const companyId = addTargetCompany(db, cfg);
  const id = addProspect(db, { name: "Jane Doe", persona: "recruiter", companyId });
  db.prepare("INSERT INTO connection (person_id, status, accepted_via) VALUES (?, 'already_connected', 'csv_import')").run(id);
  const res = queueDaily(db, cfg);
  assert.equal(res.queued, 0);
  const conn = db.prepare("SELECT status FROM connection WHERE person_id=?").get(id);
  assert.equal(conn.status, "already_connected");
  db.close();
});

test("4. invited 89 days ago skipped; 91 days ago may queue again", () => {
  const { db, cfg } = fixture();
  const companyId = addTargetCompany(db, cfg);
  const recent = addProspect(db, { name: "Recent Invite", persona: "recruiter", companyId });
  const old = addProspect(db, { name: "Old Invite", persona: "recruiter", companyId });
  db.prepare("INSERT INTO connection (person_id, status, sent_at) VALUES (?, 'withdrawn', datetime('now','-89 days'))").run(recent);
  db.prepare("INSERT INTO connection (person_id, status, sent_at) VALUES (?, 'withdrawn', datetime('now','-91 days'))").run(old);
  const res = queueDaily(db, cfg);
  assert.equal(res.queued, 1);
  assert.equal(db.prepare("SELECT status FROM connection WHERE person_id=?").get(recent).status, "withdrawn");
  assert.equal(db.prepare("SELECT status FROM connection WHERE person_id=?").get(old).status, "queued");
  db.close();
});

test("5. 15 sent today -> day cap: queued 0 even with 20 scored prospects", () => {
  const { db, cfg } = fixture();
  const companyId = addTargetCompany(db, cfg);
  for (let i = 0; i < 15; i++) {
    const id = addProspect(db, { name: `Sent Today ${i}`, persona: "recruiter", companyId });
    db.prepare("INSERT INTO connection (person_id, status, sent_at) VALUES (?, 'sent', datetime('now'))").run(id);
  }
  for (let i = 0; i < 20; i++) {
    addProspect(db, { name: `Fresh ${i}`, persona: "recruiter", companyId });
  }
  const res = queueDaily(db, cfg);
  assert.equal(res.queued, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connection WHERE status='queued'").get().n, 0);
  db.close();
});

test("6. suppressed linkedin_url skipped", () => {
  const { db, cfg } = fixture();
  const companyId = addTargetCompany(db, cfg);
  addProspect(db, { name: "Jane Doe", persona: "recruiter", companyId, url: "linkedin.com/in/jane-doe" });
  addProspect(db, { name: "Ann Lee", persona: "recruiter", companyId });
  addSuppression(db, { kind: "linkedin_url", value: "linkedin.com/in/jane-doe", reason: "manual" });
  const res = queueDaily(db, cfg);
  assert.equal(res.queued, 1);
  assert.equal(db.prepare("SELECT status FROM connection c JOIN person p ON p.id=c.person_id WHERE p.full_name='Ann Lee'").get().status, "queued");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connection c JOIN person p ON p.id=c.person_id WHERE p.full_name='Jane Doe'").get().n, 0);
  db.close();
});

test("7. 14 queued today -> only 1 more may queue (day cap on queued_at)", () => {
  const { db, cfg } = fixture();
  const companyId = addTargetCompany(db, cfg);
  for (let i = 0; i < 14; i++) {
    const id = addProspect(db, { name: `Queued ${i}`, persona: "recruiter", companyId });
    db.prepare("INSERT INTO connection (person_id, status, queued_at) VALUES (?, 'queued', datetime('now'))").run(id);
  }
  for (let i = 0; i < 5; i++) {
    addProspect(db, { name: `Fresh ${i}`, persona: "recruiter", companyId });
  }
  const res = queueDaily(db, cfg);
  assert.equal(res.queued, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connection WHERE status='queued'").get().n, 15);
  db.close();
});

test("8. 74 sent this week -> only 1 queued of 2 scored (7d headroom)", () => {
  const { db, cfg } = fixture();
  const companyId = addTargetCompany(db, cfg);
  for (let i = 0; i < 74; i++) {
    const id = addProspect(db, { name: `Week Sent ${i}`, persona: "recruiter", companyId });
    db.prepare("INSERT INTO connection (person_id, status, sent_at) VALUES (?, 'sent', datetime('now','-3 days'))").run(id);
  }
  for (let i = 0; i < 2; i++) {
    addProspect(db, { name: `Fresh ${i}`, persona: "recruiter", companyId });
  }
  const res = queueDaily(db, cfg);
  assert.equal(res.queued, 1);
  db.close();
});

test("9. blacklisted company (flag or blacklist.md name) skipped", () => {
  const { db, cfg } = fixture();
  const companyId = addTargetCompany(db, cfg);
  db.prepare("UPDATE company SET blacklisted=1 WHERE id=?").run(companyId);
  addProspect(db, { name: "Jane Doe", persona: "recruiter", companyId });
  let res = queueDaily(db, cfg);
  assert.equal(res.queued, 0);

  // blacklist.md path: a different company, unflagged, listed in the file
  mkdirSync(cfg.paths.dataDir, { recursive: true });
  writeFileSync(join(cfg.paths.dataDir, "blacklist.md"), "# do not contact\n- Omega Corp\n", "utf8");
  const omega = upsertCompany(db, { name: "Omega Corp" });
  addProspect(db, { name: "Ann Lee", persona: "recruiter", companyId: omega });
  res = queueDaily(db, cfg);
  assert.equal(res.queued, 0);
  db.close();
});

test("10. person_target row links queued person to the company's target role", () => {
  const { db, cfg } = fixture();
  const companyId = addTargetCompany(db, cfg);
  addProspect(db, { name: "Jane Doe", persona: "recruiter", companyId });
  queueDaily(db, cfg);
  const row = db.prepare(
    "SELECT t.job_ref, pt.reason FROM person_target pt JOIN target_role t ON t.id=pt.target_id JOIN person p ON p.id=pt.person_id WHERE p.full_name='Jane Doe'"
  ).get();
  assert.equal(row.job_ref, "greenhouse:g-1");
  assert.ok(row.reason);
  db.close();
});

test("11. queueDaily is idempotent: a second run queues nothing new", () => {
  const { db, cfg } = fixture();
  const companyId = addTargetCompany(db, cfg);
  addProspect(db, { name: "Jane Doe", persona: "recruiter", companyId });
  const first = queueDaily(db, cfg);
  const second = queueDaily(db, cfg);
  assert.equal(first.queued, 1);
  assert.equal(second.queued, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM connection WHERE status='queued'").get().n, 1);
  db.close();
});
