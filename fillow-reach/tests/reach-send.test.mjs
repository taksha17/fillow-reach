import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openReachDb, migrateReachDb } from "../lib/reach/db.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";
import { paceDelayMs, sameDayConflict, sendApproved } from "../lib/reach/send.mjs";

const OPTOUT = "If you'd rather not hear from me, reply 'stop' and I won't write again.";

function setup(reachYaml = "", { profileYaml = "candidate:\n  name: Robin Vega\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reach-send-"));
  const profileFile = join(dir, "profile.yaml");
  writeFileSync(profileFile, `${profileYaml}reach:\n${reachYaml}`, "utf8");
  writeFileSync(join(dir, ".env"), "REACH_MAIL_USER=me@example.com\nREACH_MAIL_PASSWORD=secret\n", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile: join(dir, ".env"), dataDir: join(dir, "data") });
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return { dir, db, cfg };
}

function addPerson(db, name = "Dana Ruiz") {
  return Number(db.prepare("INSERT INTO person (full_name, persona, source) VALUES (?, 'recruiter', 'manual')")
    .run(name).lastInsertRowid);
}

function addApproved(db, {
  channel = "email", step = 1, grounding = 1, personId = null, body = "Hi Dana", resumeAssetId = null,
} = {}) {
  const pid = personId ?? addPerson(db);
  const id = Number(db.prepare(
    "INSERT INTO message (person_id, channel, direction, step, status, body, grounding_ok, approved_by, resume_asset_id)"
    + " VALUES (?, ?, 'out', ?, 'approved', ?, ?, 'user', ?)",
  ).run(pid, channel, step, body, grounding, resumeAssetId).lastInsertRowid);
  if (channel === "email") {
    db.prepare("INSERT OR IGNORE INTO email_address (person_id, email, source, verification, is_primary) VALUES (?, ?, 'hunter', 'valid', 1)")
      .run(pid, `dana${pid}@northwind.example`);
  }
  return id;
}

const collector = () => {
  const calls = [];
  const impl = async (opts) => { calls.push(opts); return { messageId: `<smtp-${calls.length}@example>` }; };
  return { calls, impl };
};
const noSleep = async () => {};

test("1. dry run persists nothing as sent and never opens SMTP", async () => {
  const { db, cfg } = setup("  dry_run: true\n");
  assert.equal(cfg.dryRun, true);
  const id = addApproved(db);
  const { calls, impl } = collector();
  const r = await sendApproved(db, cfg, id, { sendMailImpl: impl, sleepImpl: noSleep });
  assert.equal(r.status, "dry_run");
  assert.equal(calls.length, 0, "no SMTP in a dry run");
  const row = db.prepare("SELECT status, sent_at FROM message WHERE id = ?").get(id);
  assert.equal(row.sent_at, null, "dry run records no send");
  assert.equal(row.status, "approved", "the approval stands for a later real run");
  db.close();
});

test("2. PAUSE throws before caps and leaves the message approved", async () => {
  const { db, cfg } = setup("  dry_run: false\n");
  const id = addApproved(db);
  mkdirSync(cfg.paths.reachDir, { recursive: true });
  writeFileSync(cfg.paths.pausePath, "2026-10-02 halt\n", "utf8");
  const { calls, impl } = collector();
  await assert.rejects(() => sendApproved(db, cfg, id, { sendMailImpl: impl, sleepImpl: noSleep }), /paused/i);
  assert.equal(calls.length, 0);
  const row = db.prepare("SELECT status, sent_at FROM message WHERE id = ?").get(id);
  assert.equal(row.status, "approved", "paused items stay queued, never failed");
  assert.equal(row.sent_at, null);
  db.close();
});

test("3. over the daily email cap the send throws and the message stays approved", async () => {
  const { db, cfg } = setup("  dry_run: false\n  limits:\n    emails_per_day: 2\n");
  // two emails already sent in the last 24h, to other people
  for (let i = 0; i < 2; i++) {
    const other = addApproved(db, { personId: addPerson(db, `Other ${i}`) });
    await sendApproved(db, cfg, other, { sendMailImpl: async () => ({}), sleepImpl: noSleep, pace: false });
  }
  const id = addApproved(db);
  const { calls, impl } = collector();
  await assert.rejects(
    () => sendApproved(db, cfg, id, { sendMailImpl: impl, sleepImpl: noSleep }),
    /daily email cap reached: 2\/2/,
  );
  const row = db.prepare("SELECT status, sent_at FROM message WHERE id = ?").get(id);
  assert.equal(row.status, "approved", "over cap rolls to the next day; it does not fail");
  assert.equal(row.sent_at, null);
  assert.ok(calls.length <= 1, "only the two setup sends used SMTP");
  db.close();
});

test("4. a LinkedIn message sent today defers the email to another day", async () => {
  const { db, cfg } = setup("  dry_run: false\n");
  const pid = addPerson(db);
  db.prepare(
    "INSERT INTO message (person_id, channel, direction, status, body, sent_at)"
    + " VALUES (?, 'linkedin', 'out', 'sent', 'hi', '2026-10-02 09:00:00')",
  ).run(pid);
  const id = addApproved(db, { personId: pid });
  const { calls, impl } = collector();
  const r = await sendApproved(db, cfg, id, {
    sendMailImpl: impl, sleepImpl: noSleep, now: new Date("2026-10-02T12:00:00Z"),
  });
  assert.equal(r.status, "deferred_same_day");
  assert.equal(calls.length, 0, "R3-9 blocks the send entirely");
  const row = db.prepare("SELECT status, sent_at FROM message WHERE id = ?").get(id);
  assert.equal(row.status, "queued", "it waits for tomorrow");
  assert.equal(row.sent_at, null);
  db.close();
});

test("5. sameDayConflict is channel-specific and UTC-day based", () => {
  const { db } = setup();
  const pid = addPerson(db);
  db.prepare(
    "INSERT INTO message (person_id, channel, direction, status, body, sent_at)"
    + " VALUES (?, 'linkedin', 'out', 'sent', 'hi', '2026-10-02 09:00:00')",
  ).run(pid);
  const sameDay = new Date("2026-10-02T12:00:00Z");
  assert.equal(sameDayConflict(db, pid, "email", sameDay), true, "LinkedIn today blocks email");
  assert.equal(sameDayConflict(db, pid, "linkedin", sameDay), false, "it does not block itself");
  assert.equal(sameDayConflict(db, pid, "email", new Date("2026-10-03T00:30:00Z")), false,
    "a new UTC day lifts the block, even 90 minutes later");
  db.close();
});

test("6. grounding_ok=0 is refused before any SMTP or write", async () => {
  const { db, cfg } = setup("  dry_run: false\n");
  const id = addApproved(db, { grounding: 0 });
  const { calls, impl } = collector();
  await assert.rejects(
    () => sendApproved(db, cfg, id, { sendMailImpl: impl, sleepImpl: noSleep }),
    /grounding_ok=0 and can never be sent/,
  );
  assert.equal(calls.length, 0);
  const row = db.prepare("SELECT status, sent_at FROM message WHERE id = ?").get(id);
  assert.equal(row.status, "approved", "a blocked send changes nothing");
  assert.equal(row.sent_at, null);
  db.close();
});

test("7. a happy email send carries the opt-out line, the real sender name, and the id", async () => {
  const { db, cfg } = setup("  dry_run: false\n");
  const id = addApproved(db, { body: "Hi Dana, quick question about the role." });
  const { calls, impl } = collector();
  const r = await sendApproved(db, cfg, id, { sendMailImpl: impl, sleepImpl: noSleep });
  assert.equal(r.status, "sent");
  assert.equal(calls.length, 1);
  const mail = calls[0];
  assert.match(mail.text, /quick question about the role\./);
  assert.match(mail.text, new RegExp(OPTOUT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the opt-out line is always present (CAN-SPAM)");
  assert.match(mail.from, /Robin Vega/, "R3-5: the sender's real name");
  assert.match(mail.from, /me@example\.com/);
  assert.match(mail.to, /northwind\.example/);
  const row = db.prepare("SELECT status, sent_at, provider_ref FROM message WHERE id = ?").get(id);
  assert.equal(row.status, "sent");
  assert.ok(row.sent_at);
  assert.match(row.provider_ref, /^<smtp-1@example>$/);
  db.close();
});

test("8. the opt-out line is not appended twice if the draft already has it", async () => {
  const { db, cfg } = setup("  dry_run: false\n");
  const id = addApproved(db, { body: `Hi Dana.\n\n${OPTOUT}` });
  const { calls, impl } = collector();
  await sendApproved(db, cfg, id, { sendMailImpl: impl, sleepImpl: noSleep });
  assert.equal(calls[0].text.split(OPTOUT).length - 1, 1, "exactly once");
  db.close();
});

test("9. a LinkedIn send is a mark-sent flip with no transport", async () => {
  const { db, cfg } = setup("  dry_run: false\n");
  const id = addApproved(db, { channel: "linkedin", body: "Hi Dana" });
  const { calls, impl } = collector();
  const r = await sendApproved(db, cfg, id, { sendMailImpl: impl, sleepImpl: noSleep });
  assert.equal(r.status, "sent");
  assert.equal(calls.length, 0, "queue mode never opens SMTP for a LinkedIn touch");
  const row = db.prepare("SELECT status, sent_at FROM message WHERE id = ?").get(id);
  assert.equal(row.status, "sent");
  assert.ok(row.sent_at);
  db.close();
});

test("10. an SMTP failure after commit marks the message failed and logs send_failed", async () => {
  const { db, cfg } = setup("  dry_run: false\n");
  const id = addApproved(db);
  await assert.rejects(
    () => sendApproved(db, cfg, id, {
      sendMailImpl: async () => { throw new Error("550 mailbox unavailable"); },
      sleepImpl: noSleep,
    }),
    /SMTP failed for message \d+: 550 mailbox unavailable/,
  );
  const row = db.prepare("SELECT status, error FROM message WHERE id = ?").get(id);
  assert.equal(row.status, "failed", "M3 records the failure; retry policy is M5");
  assert.match(row.error, /550/);
  const ev = db.prepare("SELECT agent, action, detail FROM event_log WHERE entity_id = ? AND action = 'send_failed'").get(id);
  assert.equal(ev.agent, "outreach");
  assert.match(JSON.parse(ev.detail).error, /550/);
  db.close();
});

test("11. suppression between approval and send cancels the message", async () => {
  const { db, cfg } = setup("  dry_run: false\n");
  const id = addApproved(db);
  db.prepare("INSERT INTO suppression (kind, value, reason) VALUES ('email', ?, 'optout')")
    .run(`dana${db.prepare("SELECT person_id FROM message WHERE id = ?").get(id).person_id}@northwind.example`);
  const { calls, impl } = collector();
  await assert.rejects(() => sendApproved(db, cfg, id, { sendMailImpl: impl, sleepImpl: noSleep }), /suppressed/);
  assert.equal(calls.length, 0);
  assert.equal(db.prepare("SELECT status FROM message WHERE id = ?").get(id).status, "cancelled");
  db.close();
});

test("12. an unverified or missing address stops the email before it is marked sent", async () => {
  const { db, cfg } = setup("  dry_run: false\n");
  const pid = addPerson(db, "No Address");
  const id = Number(db.prepare(
    "INSERT INTO message (person_id, channel, direction, step, status, body, grounding_ok)"
    + " VALUES (?, 'email', 'out', 1, 'approved', 'hi', 1)",
  ).run(pid).lastInsertRowid);
  const { calls, impl } = collector();
  await assert.rejects(
    () => sendApproved(db, cfg, id, { sendMailImpl: impl, sleepImpl: noSleep }),
    /no verified address/,
  );
  assert.equal(calls.length, 0);
  assert.equal(db.prepare("SELECT status, sent_at FROM message WHERE id = ?").get(id).status, "approved");
  db.close();
});

test("13. resume attachment follows attach_resume: step 1 gets none by default", async () => {
  const { db, cfg } = setup("  dry_run: false\n  email:\n    attach_resume: followup\n");
  mkdirSync(join(cfg.paths.dataDir, "tailored"), { recursive: true });
  const file = join(cfg.paths.dataDir, "tailored", "resume.md");
  writeFileSync(file, "resume text\n", "utf8");
  const assetId = Number(db.prepare("INSERT INTO resume_asset (job_ref, path, sha256) VALUES ('gh:x', 'tailored/resume.md', 'a')")
    .run().lastInsertRowid);

  const first = addApproved(db, { resumeAssetId: assetId, step: 1 });
  const { calls, impl } = collector();
  await sendApproved(db, cfg, first, { sendMailImpl: impl, sleepImpl: noSleep });
  assert.deepEqual(calls[0].attachments, [], "no resume on the first cold email");

  const second = addApproved(db, { resumeAssetId: assetId, step: 2, personId: addPerson(db, "Followup Target") });
  await sendApproved(db, cfg, second, { sendMailImpl: impl, sleepImpl: noSleep });
  assert.equal(calls[1].attachments.length, 1);
  assert.equal(calls[1].attachments[0].filename, "resume.md");
  db.close();
});

test("14. attach_resume: first attaches on step 1 and never on step 2", async () => {
  const { db, cfg } = setup("  dry_run: false\n  email:\n    attach_resume: first\n");
  mkdirSync(join(cfg.paths.dataDir, "tailored"), { recursive: true });
  writeFileSync(join(cfg.paths.dataDir, "tailored", "resume.md"), "resume text\n", "utf8");
  const assetId = Number(db.prepare("INSERT INTO resume_asset (job_ref, path, sha256) VALUES ('gh:x', 'tailored/resume.md', 'a')")
    .run().lastInsertRowid);
  const { calls, impl } = collector();

  const one = addApproved(db, { resumeAssetId: assetId, step: 1 });
  await sendApproved(db, cfg, one, { sendMailImpl: impl, sleepImpl: noSleep });
  assert.equal(calls[0].attachments.length, 1);

  const two = addApproved(db, { resumeAssetId: assetId, step: 2, personId: addPerson(db, "Later") });
  await sendApproved(db, cfg, two, { sendMailImpl: impl, sleepImpl: noSleep });
  assert.deepEqual(calls[1].attachments, []);
  db.close();
});

test("15. sendApproved rejects a draft that is not approved, and an inbound row", async () => {
  const { db, cfg } = setup("  dry_run: false\n");
  const pid = addPerson(db);
  const needsApproval = Number(db.prepare(
    "INSERT INTO message (person_id, channel, direction, status, body, grounding_ok)"
    + " VALUES (?, 'email', 'out', 'needs_approval', 'hi', 1)",
  ).run(pid).lastInsertRowid);
  await assert.rejects(() => sendApproved(db, cfg, needsApproval, {}), /is needs_approval, not approved or queued/);
  await assert.rejects(() => sendApproved(db, cfg, 999, {}), /no message 999/);
  db.close();
});

test("16. paceDelayMs stays inside the configured window", () => {
  const { cfg } = setup("  limits:\n    pace_seconds: [45, 180]\n");
  assert.equal(paceDelayMs(cfg, () => 0), 45000);
  assert.equal(paceDelayMs(cfg, () => 1), 180000);
  assert.equal(paceDelayMs(cfg, () => 0.5), 112500);
});
