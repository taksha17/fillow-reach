import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openReachDb, migrateReachDb, openReachMigratedDb } from "../lib/reach/db.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";
import { upsertCompany, upsertPerson } from "../lib/reach/people.mjs";
import { pause } from "../lib/reach/killswitch.mjs";
import {
  funnelCounts,
  todayQueue,
  approvalQueue,
  personTimeline,
  markInviteSent,
} from "../lib/reach/dashboard-data.mjs";
import { consolePageHtml, startReachUi, escapeHtml } from "../lib/reach/ui.mjs";
import { runReachCli } from "../lib/reach/cli.mjs";

function mem() {
  const db = openReachDb(":memory:");
  migrateReachDb(db);
  return db;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reach-dash-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, "reach:\n  enabled: true\n", "utf8");
  writeFileSync(envFile, "", "utf8");
  return { profileFile, envFile, dataDir: join(dir, "data") };
}

function seedQueued(db, { name = "Ada Lovelace", title = "Recruiter", company = "X Corp", url = "https://linkedin.com/in/ada", score = 80 } = {}) {
  const companyId = upsertCompany(db, { name: company });
  const { personId } = upsertPerson(db, {
    full_name: name, title, companyId, linkedin_url: url, source: "manual", relevance_score: score,
  });
  db.prepare("INSERT INTO connection (person_id, status, queued_at) VALUES (?, 'queued', datetime('now'))").run(personId);
  return personId;
}

test("1. empty funnel is all zeros", () => {
  const db = mem();
  assert.deepEqual(funnelCounts(db), {
    prospect: 0, invited: 0, connected: 0, messaged: 0, replied: 0, closed: 0, suppressed: 0,
  });
  db.close();
});

test("2. console shell carries the pipeline tabs and the session token", () => {
  const html = consolePageHtml("tok-abc123tok-abc123");
  for (const marker of ["fillow Reach", "data-token=\"tok-abc123tok-abc123\"", "Queue", "Drafts", "People", "Targets", "Activity", "Import", "/api/state"]) {
    assert.ok(html.includes(marker), `missing ${marker}`);
  }
});

test("3. markInviteSent flips queued to sent_via manual", () => {
  const db = mem();
  const personId = seedQueued(db);
  markInviteSent(db, personId);
  const c = db.prepare("SELECT status, sent_via, sent_at FROM connection WHERE person_id = ?").get(personId);
  assert.equal(c.status, "sent");
  assert.equal(c.sent_via, "manual");
  assert.ok(c.sent_at);
  const p = db.prepare("SELECT lifecycle FROM person WHERE id = ?").get(personId);
  assert.equal(p.lifecycle, "invited");
  const ev = db.prepare("SELECT action, agent FROM event_log WHERE action = 'invite_marked_sent'").get();
  assert.equal(ev.action, "invite_marked_sent");
  assert.equal(ev.agent, "report");
  db.close();
});

test("4. person pages escape script in a person name", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  const companyId = upsertCompany(db, { name: "X Corp" });
  const { personId } = upsertPerson(db, {
    full_name: "<script>alert(1)</script>", title: "Recruiter", companyId, source: "manual",
  });
  db.close();
  const { server, url } = await startReachUi(cfg, { port: 0, host: "127.0.0.1" });
  try {
    const res = await fetch(`${url}/person/${personId}`);
    const html = await res.text();
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("\u0026lt;script\u0026gt;alert(1)\u0026lt;/script\u0026gt;"));
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  assert.equal(escapeHtml("<b>x</b>"), "\u0026lt;b\u0026gt;x\u0026lt;/b\u0026gt;");
});

test("5. todayQueue and approvalQueue read fixture rows", () => {
  const db = mem();
  const personId = seedQueued(db, { name: "Jane Doe", title: "Talent", company: "Acme Inc" });
  db.prepare(
    "INSERT INTO message (person_id, channel, status, body) VALUES (?, 'email', 'needs_approval', 'hello')",
  ).run(personId);
  const q = todayQueue(db);
  assert.equal(q.length, 1);
  assert.equal(q[0].full_name, "Jane Doe");
  assert.equal(q[0].title, "Talent");
  assert.match(q[0].company, /Acme/i);
  const a = approvalQueue(db);
  assert.equal(a.length, 1);
  assert.equal(a[0].person_id, personId);
  const tl = personTimeline(db, personId);
  assert.ok(Array.isArray(tl));
  db.close();
});

test("6. startReachUi on port 0 serves the console and the mark-sent API", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  const personId = seedQueued(db, { name: "Ada Lovelace" });
  db.close();
  const { server, url, token } = await startReachUi(cfg, { port: 0, host: "127.0.0.1" });
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+/);
    const home = await fetch(url);
    const html = await home.text();
    assert.match(html, /data-token=/);
    const res = await fetch(`${url}/api/mark-sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Reach-Token": token },
      body: JSON.stringify({ personId }),
    });
    assert.equal(res.status, 200);
    const db2 = openReachMigratedDb(cfg);
    const c = db2.prepare("SELECT status, sent_via FROM connection WHERE person_id = ?").get(personId);
    assert.equal(c.status, "sent");
    assert.equal(c.sent_via, "manual");
    db2.close();
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("7. paused state flows through /api/state and mark-sent still works", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  const personId = seedQueued(db);
  db.close();
  pause(cfg, "test");
  const { server, url, token } = await startReachUi(cfg, { port: 0, host: "127.0.0.1" });
  try {
    const st = await (await fetch(`${url}/api/state`)).json();
    assert.equal(st.paused, true);
    const res = await fetch(`${url}/api/mark-sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Reach-Token": token },
      body: JSON.stringify({ personId }),
    });
    assert.equal(res.status, 200);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  const db2 = openReachMigratedDb(cfg);
  const c = db2.prepare("SELECT sent_via FROM connection WHERE person_id = ?").get(personId);
  assert.equal(c.sent_via, "manual");
  db2.close();
});

test("8. CLI usage lists reach ui", async () => {
  const fx = fixture();
  let out = "";
  const code = await runReachCli([], { stdout: { write: (s) => { out += String(s); } }, ...fx });
  assert.equal(code, 1);
  assert.match(out, /reach ui/);
});
