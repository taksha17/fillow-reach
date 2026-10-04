import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { startReachUi } from "../lib/reach/ui.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reach-ui-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, "reach:\n  enabled: true\n", "utf8");
  writeFileSync(envFile, "", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir });
  return { cfg, dir };
}

// fetch keep-alive sockets otherwise hold the process open after tests.
function stop(server) {
  server.closeAllConnections?.();
  server.close();
}

function rawStatus(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

async function start(fx) {
  const handle = await startReachUi(fx.cfg, { host: "127.0.0.1", port: 0 });
  return handle;
}

async function json(fetch, path, opts = {}) {
  const res = await fetch(path, opts);
  return { status: res.status, body: await res.json().catch(() => null), res };
}

async function text(fetch, path, opts = {}) {
  const res = await fetch(path, opts);
  return { status: res.status, body: await res.text() };
}

test("1. console page renders with embedded token and pipeline tabs", async () => {
  const fx = fixture();
  const { server, url, token } = await start(fx);
  const fetch = (p, o) => globalThis.fetch(`${url}${p}`, o);
  const page = await text(fetch, "/");
  assert.equal(page.status, 200);
  for (const marker of ["fillow Reach", "data-token", "Queue", "Drafts", "People", "Targets", "Activity", "Import"]) {
    assert.ok(page.body.includes(marker), `missing ${marker}`);
  }
  assert.ok(token && token.length >= 16);
  stop(server);
});

test("2. /api/state returns the full pipeline payload", async () => {
  const fx = fixture();
  const { server, url, token } = await start(fx);
  const fetch = (p, o) => globalThis.fetch(`${url}${p}`, o);
  const { status, body } = await json(fetch, "/api/state");
  assert.equal(status, 200);
  for (const key of ["funnel", "queue", "approvals", "drafts", "people", "targets", "events", "usage", "limits", "health", "paused", "dryRun", "busy"]) {
    assert.ok(key in body, `missing ${key}`);
  }
  assert.equal(body.dryRun, true);
  assert.equal(body.busy, false);
  stop(server);
});

test("3. every POST requires the per-session token", async () => {
  const fx = fixture();
  const { server, url, token } = await start(fx);
  const fetch = (p, o) => globalThis.fetch(`${url}${p}`, o);
  const post = (path, payload, hdrs) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(hdrs ?? {}) },
    body: JSON.stringify(payload ?? {}),
  });
  assert.equal((await post("/api/suppress", { kind: "email", value: "x@y.test" })).status, 403);
  assert.equal((await post("/api/suppress", { kind: "email", value: "x@y.test" }, { "X-Reach-Token": token })).status, 200);
  stop(server);
});

test("4. non-loopback Host header is rejected (DNS-rebinding guard)", async () => {
  const fx = fixture();
  const { server, url, port } = await start(fx);
  void url;
  const status = await rawStatus(port, "/api/state", { Host: "evil.example" });
  assert.equal(status, 403);
  stop(server);
});

test("5. import-paste is review-first: preview writes nothing, apply writes", async () => {
  const fx = fixture();
  const { server, url, token } = await start(fx);
  const fetch = (p, o) => globalThis.fetch(`${url}${p}`, o);
  const post = (path, payload) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Reach-Token": token },
    body: JSON.stringify(payload),
  });
  const paste = "Jane Doe — Technical Recruiter at Acme\nhttps://www.linkedin.com/in/jane-doe";
  const prev = await (await post("/api/import-paste", { text: paste, apply: false })).json();
  assert.equal(prev.parsed, 1);
  assert.equal(prev.imported, 0);
  const db = openReachMigratedDb(fx.cfg);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  db.close();
  const applied = await (await post("/api/import-paste", { text: paste, apply: true })).json();
  assert.equal(applied.imported, 1);
  const db2 = openReachMigratedDb(fx.cfg);
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM person").get().n, 1);
  db2.close();
  stop(server);
});

test("6. draft approve and reject decisions flow through", async () => {
  const fx = fixture();
  const { server, url, token } = await start(fx);
  const fetch = (p, o) => globalThis.fetch(`${url}${p}`, o);
  const post = (path, payload) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Reach-Token": token },
    body: JSON.stringify(payload),
  });
  const db = openReachMigratedDb(fx.cfg);
  const pid = Number(db.prepare(
    "INSERT INTO person (full_name, persona, source) VALUES ('Ann Lee', 'recruiter', 'manual')",
  ).run().lastInsertRowid);
  const mid = Number(db.prepare(
    "INSERT INTO message (person_id, channel, direction, step, status, body, grounding_ok) VALUES (?, 'linkedin', 'out', 1, 'needs_approval', 'hello', 1)",
  ).run(pid).lastInsertRowid);
  const rejectedId = Number(db.prepare(
    "INSERT INTO message (person_id, channel, direction, step, status, body, grounding_ok) VALUES (?, 'linkedin', 'out', 1, 'needs_approval', 'nope', 1)",
  ).run(pid).lastInsertRowid);
  db.close();
  assert.equal((await post("/api/draft", { messageId: mid, decision: "approve" })).status, 200);
  assert.equal((await post("/api/draft", { messageId: rejectedId, decision: "reject" })).status, 200);
  const db2 = openReachMigratedDb(fx.cfg);
  assert.equal(db2.prepare("SELECT status FROM message WHERE id=?").get(mid).status, "approved");
  assert.equal(db2.prepare("SELECT status FROM message WHERE id=?").get(rejectedId).status, "cancelled");
  db2.close();
  stop(server);
});

test("7. suppress and mark-sent actions mutate and are audited", async () => {
  const fx = fixture();
  const { server, url, token } = await start(fx);
  const fetch = (p, o) => globalThis.fetch(`${url}${p}`, o);
  const post = (path, payload) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Reach-Token": token },
    body: JSON.stringify(payload),
  });
  const db = openReachMigratedDb(fx.cfg);
  const pid = Number(db.prepare(
    "INSERT INTO person (full_name, persona, source) VALUES ('Sam Cole', 'recruiter', 'manual')",
  ).run().lastInsertRowid);
  db.prepare("INSERT INTO connection (person_id, status, queued_at) VALUES (?, 'queued', datetime('now'))").run(pid);
  db.close();
  assert.equal((await post("/api/mark-sent", { personId: pid })).status, 200);
  assert.equal((await post("/api/suppress", { kind: "domain", value: "optout.test" })).status, 200);
  const db2 = openReachMigratedDb(fx.cfg);
  assert.equal(db2.prepare("SELECT status FROM connection WHERE person_id=?").get(pid).status, "sent");
  assert.ok(db2.prepare("SELECT 1 FROM suppression WHERE kind='domain' AND value='optout.test'").get());
  db2.close();
  stop(server);
});

test("8. run action: prospect executes in-process and reports stats", async () => {
  const fx = fixture();
  const { server, url, token } = await start(fx);
  const fetch = (p, o) => globalThis.fetch(`${url}${p}`, o);
  const post = (path, payload) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Reach-Token": token },
    body: JSON.stringify(payload),
  });
  const res = await post("/api/run", { agent: "prospect" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.stats && "queued" in body.stats, JSON.stringify(body));
  assert.equal(body.agent, "prospect");
  const { body: state } = await json(fetch, "/api/state");
  assert.equal(state.busy, false);
  stop(server);
});

test("9. pause/resume toggles the kill switch through the UI", async () => {
  const fx = fixture();
  const { server, url, token } = await start(fx);
  const fetch = (p, o) => globalThis.fetch(`${url}${p}`, o);
  const post = (path) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Reach-Token": token },
    body: "{}",
  });
  await post("/api/pause");
  let { body: state } = await json(fetch, "/api/state");
  assert.equal(state.paused, true);
  await post("/api/resume");
  ({ body: state } = await json(fetch, "/api/state"));
  assert.equal(state.paused, false);
  stop(server);
});

test("10. forget requires an explicit confirm flag", async () => {
  const fx = fixture();
  const { server, url, token } = await start(fx);
  const fetch = (p, o) => globalThis.fetch(`${url}${p}`, o);
  const post = (path, payload) => fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Reach-Token": token },
    body: JSON.stringify(payload),
  });
  const db = openReachMigratedDb(fx.cfg);
  const pid = Number(db.prepare(
    "INSERT INTO person (full_name, persona, source) VALUES ('Temp Person', 'other', 'manual')",
  ).run().lastInsertRowid);
  db.close();
  assert.equal((await post("/api/forget", { personId: pid })).status, 400);
  assert.equal((await post("/api/forget", { personId: pid, confirm: true })).status, 200);
  const db2 = openReachMigratedDb(fx.cfg);
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM person WHERE id=?").get(pid).n, 0);
  db2.close();
  stop(server);
});
