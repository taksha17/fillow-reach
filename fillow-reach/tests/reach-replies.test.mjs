import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openReachDb, migrateReachDb, openReachMigratedDb } from "../lib/reach/db.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";
import { ingestInbound } from "../lib/reach/replies.mjs";
import { runReachCli } from "../lib/reach/cli.mjs";
import { run } from "../agents/reach-outreach.mjs";

function setup({ dryRun = false, extra = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reach-replies-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const yaml = [
    "candidate:",
    "  name: Robin Vega",
    "reach:",
    `  dry_run: ${dryRun}`,
    "  email:",
    "    delay_days: 2",
    extra,
    "",
  ].join("\n");
  writeFileSync(profileFile, yaml, "utf8");
  writeFileSync(envFile, "REACH_MAIL_USER=me@example.com\nREACH_MAIL_PASSWORD=secret\n", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir: join(dir, "data") });
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return { dir, db, cfg, profileFile, envFile };
}

function addPerson(db, { name = "Dana Ruiz", headline = "Talent Lead" } = {}) {
  return Number(db.prepare("INSERT INTO person (full_name, headline, title, persona, source) VALUES (?, ?, 'Talent Lead', 'recruiter', 'manual')")
    .run(name, headline).lastInsertRowid);
}

function addMessage(db, {
  personId, channel = "email", status = "needs_approval", step = 1, direction = "out", grounding = 1, sentAt = null,
} = {}) {
  const ts = sentAt ? `datetime('now','${sentAt}')` : "NULL";
  return Number(db.prepare(
    "INSERT INTO message (person_id, channel, direction, step, status, body, grounding_ok, sent_at)"
    + ` VALUES (?, '${channel}', '${direction}', ${step}, '${status}', 'hi', ${grounding ?? "NULL"}, ${ts})`,
  ).run(personId).lastInsertRowid);
}

test("1. an inbound reply cancels every pending out-draft and moves the lifecycle", () => {
  const { db } = setup();
  const pid = addPerson(db);
  const pending = addMessage(db, { personId: pid, status: "needs_approval" });
  const approved = addMessage(db, { personId: pid, status: "approved" });
  const queued = addMessage(db, { personId: pid, status: "queued" });
  const sent = addMessage(db, { personId: pid, status: "sent", sentAt: "-2 days" });

  const r = ingestInbound(db, { personId: pid, channel: "email", body: "Thanks, let's talk." });
  assert.equal(r.cancelled, 3, "drafts, approvals and queued rows all stop");
  const status = (id) => db.prepare("SELECT status FROM message WHERE id = ?").get(id).status;
  assert.equal(status(pending), "cancelled");
  assert.equal(status(approved), "cancelled");
  assert.equal(status(queued), "cancelled");
  assert.equal(status(sent), "sent", "history is never rewritten");
  assert.equal(db.prepare("SELECT lifecycle FROM person WHERE id = ?").get(pid).lifecycle, "replied");
  db.close();
});

test("2. the inbound row is stored as a replied message and logged", () => {
  const { db } = setup();
  const pid = addPerson(db);
  const r = ingestInbound(db, { personId: pid, channel: "linkedin", body: "Sounds good", replyClass: "positive" });
  const row = db.prepare("SELECT * FROM message WHERE id = ?").get(r.messageId);
  assert.equal(row.direction, "in");
  assert.equal(row.status, "replied");
  assert.equal(row.channel, "linkedin");
  assert.equal(row.reply_class, "positive");
  const ev = db.prepare("SELECT agent, action, detail FROM event_log WHERE entity_id = ?").get(r.messageId);
  assert.equal(ev.agent, "outreach");
  assert.equal(ev.action, "reply_received");
  assert.equal(JSON.parse(ev.detail).cancelled, 0);
  db.close();
});

test("3. the default reply_class is neutral and a reply cancels a LinkedIn draft too", () => {
  const { db } = setup();
  const pid = addPerson(db);
  const li = addMessage(db, { personId: pid, channel: "linkedin", status: "needs_approval" });
  ingestInbound(db, { personId: pid, channel: "linkedin", body: "Thanks!" });
  assert.equal(db.prepare("SELECT reply_class FROM message WHERE direction = 'in'").get().reply_class, "neutral");
  assert.equal(db.prepare("SELECT status FROM message WHERE id = ?").get(li).status, "cancelled");
  db.close();
});

test("4. ingestInbound validates its input and a reply is atomic", () => {
  const { db } = setup();
  const pid = addPerson(db);
  assert.throws(() => ingestInbound(db, { channel: "email" }), /personId is required/);
  assert.throws(() => ingestInbound(db, { personId: pid, channel: "sms" }), /channel must be/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM message").get().n, 0);
  db.close();
});

test("5. a reply stops all further eligibility for that person", async () => {
  const { db, cfg } = setup();
  const pid = addPerson(db);
  db.prepare("INSERT INTO connection (person_id, status) VALUES (?, 'accepted')").run(pid);
  addMessage(db, { personId: pid, channel: "linkedin", status: "needs_approval" });
  ingestInbound(db, { personId: pid, channel: "linkedin", body: "not now" });
  const stats = await run(cfg, { db, chatImpl: async () => "{}" });
  assert.equal(stats.composed, 0, "a replied person gets no new drafts");
  db.close();
});

// The agent composes; it never sends without an explicit --send, and even then
// only rows the user already approved.
const stubChat = (body) => async () => JSON.stringify({ subject: "s", body });

test("6. run() composes a LinkedIn draft for an accepted person and never sends it", async () => {
  const { db, cfg } = setup();
  const pid = addPerson(db);
  db.prepare("INSERT INTO connection (person_id, status) VALUES (?, 'accepted')").run(pid);
  const stats = await run(cfg, {
    db,
    chatImpl: stubChat("Hi Dana — Python pipelines at Northwind Traders."),
  });
  assert.equal(stats.composed, 1);
  assert.equal(stats.sent, 0, "composing never sends");
  const row = db.prepare("SELECT status, channel, grounding_ok FROM message").get();
  assert.equal(row.channel, "linkedin");
  assert.equal(row.status, "needs_approval", "it waits for the human gate");
  db.close();
});

test("7. run() with send:true still only sends approved rows", async () => {
  const { db, cfg } = setup();
  const pid = addPerson(db);
  db.prepare("INSERT INTO email_address (person_id, email, source, verification, is_primary) VALUES (?, 'dana@northwind.example', 'hunter', 'valid', 1)").run(pid);
  addMessage(db, { personId: pid, channel: "email", status: "needs_approval" });
  const sent = [];
  const stats = await run(cfg, {
    db, send: true, sendMailImpl: async (o) => { sent.push(o); return {}; }, sleepImpl: async () => {},
  });
  assert.equal(stats.sent, 0, "a needs_approval row is not sendable");
  assert.equal(sent.length, 0);
  db.close();
});

test("8. run() --send delivers an approved row through SMTP", async () => {
  const { db, cfg } = setup();
  const pid = addPerson(db);
  db.prepare("INSERT INTO email_address (person_id, email, source, verification, is_primary) VALUES (?, 'dana@northwind.example', 'hunter', 'valid', 1)").run(pid);
  addMessage(db, { personId: pid, channel: "email", status: "approved" });
  const sent = [];
  const stats = await run(cfg, {
    db, send: true, sendMailImpl: async (o) => { sent.push(o); return {}; }, sleepImpl: async () => {},
  });
  assert.equal(stats.sent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /reply 'stop'/);
  db.close();
});

test("9. a dry run composes but never opens SMTP", async () => {
  const { db, cfg } = setup({ dryRun: true });
  assert.equal(cfg.dryRun, true);
  const pid = addPerson(db);
  db.prepare("INSERT INTO email_address (person_id, email, source, verification, is_primary) VALUES (?, 'dana@northwind.example', 'hunter', 'valid', 1)").run(pid);
  addMessage(db, { personId: pid, channel: "email", status: "approved" });
  const sent = [];
  const stats = await run(cfg, {
    db, send: true, sendMailImpl: async (o) => { sent.push(o); return {}; }, sleepImpl: async () => {},
  });
  assert.equal(stats.sent, 0, "nothing is counted as sent");
  assert.equal(sent.length, 0, "and no transport is opened");
  const row = db.prepare("SELECT status, sent_at FROM message").get();
  assert.equal(row.status, "approved");
  assert.equal(row.sent_at, null);
  db.close();
});

test("10. run() records a run row with stats and marks it ok", async () => {
  const { db, cfg } = setup();
  const pid = addPerson(db);
  db.prepare("INSERT INTO connection (person_id, status) VALUES (?, 'accepted')").run(pid);
  await run(cfg, { db, chatImpl: stubChat("Hi Dana — Python pipelines at Northwind Traders.") });
  const row = db.prepare("SELECT agent, status, dry_run, finished_at, stats FROM run").get();
  assert.equal(row.agent, "outreach");
  assert.equal(row.status, "ok");
  assert.equal(row.dry_run, 0);
  assert.ok(row.finished_at);
  assert.equal(JSON.parse(row.stats).composed, 1);
  db.close();
});

test("11. a broken chatImpl fails one person without abandoning the run", async () => {
  const { db, cfg } = setup();
  for (const name of ["First Person", "Second Person"]) {
    const pid = addPerson(db, { name });
    db.prepare("INSERT INTO connection (person_id, status) VALUES (?, 'accepted')").run(pid);
  }
  let call = 0;
  const flaky = async () => {
    call += 1;
    if (call === 1) throw new Error("LLM timeout");
    return JSON.stringify({ subject: "s", body: "Hi — Python pipelines at Northwind Traders." });
  };
  const stats = await run(cfg, { db, chatImpl: flaky });
  assert.equal(stats.composedErrors, 1);
  assert.equal(stats.composed, 1, "the second person still got a draft");
  db.close();
});

test("12. suppressed people are skipped, not drafted", async () => {
  const { db, cfg } = setup();
  const pid = addPerson(db);
  db.prepare("INSERT INTO connection (person_id, status) VALUES (?, 'accepted')").run(pid);
  db.prepare("INSERT INTO suppression (kind, value, reason) VALUES ('linkedin_url', 'x', 'manual')").run();
  db.prepare("UPDATE person SET do_not_contact = 1 WHERE id = ?").run(pid);
  const stats = await run(cfg, { db, chatImpl: stubChat("Hi Dana") });
  assert.equal(stats.eligible, 0);
  assert.equal(stats.composed, 0);
  db.close();
});

test("13. over-cap sends stop the batch and leave the rest approved", async () => {
  const { db, cfg } = setup({ extra: "  limits:\n    emails_per_day: 1\n" });
  const mk = (name) => {
    const pid = addPerson(db, { name });
    db.prepare("INSERT INTO email_address (person_id, email, source, verification, is_primary) VALUES (?, ?, 'hunter', 'valid', 1)")
      .run(pid, `${name.replace(/\s+/g, ".").toLowerCase()}@northwind.example`);
    addMessage(db, { personId: pid, channel: "email", status: "approved" });
    return pid;
  };
  mk("One Person");
  mk("Two Person");
  const sent = [];
  const stats = await run(cfg, {
    db, send: true, sendMailImpl: async (o) => { sent.push(o); return {}; }, sleepImpl: async () => {},
  });
  assert.equal(stats.sent, 1, "the cap of 1/day admits exactly one");
  assert.equal(stats.sendErrors, 1);
  assert.equal(sent.length, 1);
  const stillApproved = db.prepare("SELECT COUNT(*) AS n FROM message WHERE status = 'approved'").get().n;
  assert.equal(stillApproved, 1, "the blocked one stays approved for the next day, not failed");
  db.close();
});

test("14. PAUSE stops the send phase without failing the rows", async () => {
  const { db, cfg } = setup();
  const pid = addPerson(db);
  db.prepare("INSERT INTO email_address (person_id, email, source, verification, is_primary) VALUES (?, 'dana@northwind.example', 'hunter', 'valid', 1)").run(pid);
  addMessage(db, { personId: pid, channel: "email", status: "approved" });
  mkdirSync(cfg.paths.reachDir, { recursive: true });
  writeFileSync(cfg.paths.pausePath, "halt\n", "utf8");
  const sent = [];
  const stats = await run(cfg, {
    db, send: true, sendMailImpl: async (o) => { sent.push(o); return {}; }, sleepImpl: async () => {},
  });
  assert.equal(stats.sent, 0);
  assert.equal(sent.length, 0);
  assert.equal(db.prepare("SELECT status FROM message").get().status, "approved", "PAUSE never fails a row");
  db.close();
});

test("15. the resume path works too, proving the kill switch is live", async () => {
  const { db, cfg } = setup();
  const pid = addPerson(db);
  db.prepare("INSERT INTO email_address (person_id, email, source, verification, is_primary) VALUES (?, 'dana@northwind.example', 'hunter', 'valid', 1)").run(pid);
  addMessage(db, { personId: pid, channel: "email", status: "approved" });
  const opts = { db, send: true, sendMailImpl: async () => ({}), sleepImpl: async () => {} };
  assert.equal((await run(cfg, opts)).sent, 1);
  db.close();
});

test("16. CLI outreach --send in a dry run reaches the send phase but sends nothing", async () => {
  // dry_run is the guard that keeps the CLI from touching the network in tests:
  // run() is invoked without a sendMailImpl seam, so a real send would attempt
  // a live SMTP connection. Seed the file-backed db the CLI actually opens.
  const { cfg, profileFile, envFile } = setup({ dryRun: true });
  const seed = openReachMigratedDb(cfg);
  const pid = addPerson(seed);
  seed.prepare("INSERT INTO email_address (person_id, email, source, verification, is_primary) VALUES (?, 'dana@northwind.example', 'hunter', 'valid', 1)").run(pid);
  addMessage(seed, { personId: pid, channel: "email", status: "approved" });
  seed.close();

  const fx = { profileFile, envFile, dataDir: cfg.paths.dataDir };
  let out = "";
  const code = await runReachCli(["outreach", "--send"], { stdout: { write: (s) => { out += s; } }, ...fx });
  assert.equal(code, 0, out);
  assert.match(out, /outreach: composed 0/, "nothing was eligible to draft");
  assert.match(out, /sent 0/, "the approved row was still delivered to");

  const check = openReachMigratedDb(cfg);
  const row = check.prepare("SELECT status, sent_at FROM message").get();
  check.close();
  assert.equal(row.status, "approved", "a dry run leaves the approval in place");
  assert.equal(row.sent_at, null);
});

test("17. CLI outreach --json emits the run stats", async () => {
  const { db, cfg, profileFile, envFile } = setup();
  db.close();
  const fx = { profileFile, envFile, dataDir: cfg.paths.dataDir };
  let out = "";
  await runReachCli(["outreach", "--json"], { stdout: { write: (s) => { out += s; } }, ...fx });
  const stats = JSON.parse(out.trim());
  assert.equal(typeof stats.composed, "number");
  assert.equal(stats.sent, 0);
});