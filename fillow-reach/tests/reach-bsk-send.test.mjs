import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { isPaused } from "../lib/reach/killswitch.mjs";
import { upsertCompany, upsertPerson } from "../lib/reach/people.mjs";
import { hasBskAck, writeBskAck, detectLinkedinHazard } from "../lib/reach/bsk-send.mjs";
import { sendApproved } from "../lib/reach/send.mjs";

function fixture(yaml = "reach:\n  enabled: true\n  linkedin:\n    send_mode: queue\n") {
  const dir = mkdtempSync(join(tmpdir(), "reach-bsk-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, yaml, "utf8");
  writeFileSync(envFile, "", "utf8");
  return { profileFile, envFile, dataDir: join(dir, "data") };
}

function seedPerson(db) {
  const companyId = upsertCompany(db, { name: "Acme" });
  const { personId } = upsertPerson(db, {
    full_name: "Ada Lovelace",
    companyId,
    linkedin_url: "https://www.linkedin.com/in/adalovelace",
    source: "manual",
  });
  db.prepare("INSERT INTO connection (person_id, status, queued_at) VALUES (?, 'queued', datetime('now'))").run(personId);
  return personId;
}

test("1. detectLinkedinHazard matches restriction copy and off-host urls", () => {
  assert.match(detectLinkedinHazard("we restricted your account", "https://www.linkedin.com/in/x") || "", /restrict/i);
  assert.equal(detectLinkedinHazard("Welcome Ada", "https://www.linkedin.com/in/ada"), null);
  assert.ok(detectLinkedinHazard("ok", "https://example.com/login"));
});

test("2. queue mode never calls bskImpl", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  const personId = seedPerson(db);
  let calls = 0;
  await sendApproved(db, cfg, {
    personId, channel: "linkedin", kind: "invite", body: "note",
    bskImpl: async () => { calls += 1; return { pageText: "ok", pageUrl: "https://linkedin.com/in/ada" }; },
  });
  assert.equal(calls, 0);
  db.close();
});

test("3. bsk without ack throws acknowledgement; no PAUSE file", async () => {
  const fx = fixture("reach:\n  enabled: true\n  linkedin:\n    send_mode: bsk\n");
  const cfg = loadReachConfig(fx);
  const db = openReachMigratedDb(cfg);
  const personId = seedPerson(db);
  assert.equal(hasBskAck(cfg), false);
  await assert.rejects(
    () => sendApproved(db, cfg, { personId, channel: "linkedin", kind: "invite", bskImpl: async () => ({}) }),
    /acknowledgement/,
  );
  assert.equal(isPaused(cfg), false);
  assert.equal(existsSync(cfg.paths.pausePath), false);
  db.close();
});

test("4. warning page copy creates PAUSE", async () => {
  const fx = fixture("reach:\n  enabled: true\n  linkedin:\n    send_mode: bsk\n");
  const cfg = loadReachConfig(fx);
  writeBskAck(cfg);
  const db = openReachMigratedDb(cfg);
  const personId = seedPerson(db);
  await assert.rejects(
    () => sendApproved(db, cfg, {
      personId, channel: "linkedin", kind: "invite",
      bskImpl: async () => ({ pageText: "we restricted your account", pageUrl: "https://www.linkedin.com/in/ada" }),
    }),
    /restrict/i,
  );
  assert.equal(isPaused(cfg), true);
  db.close();
});

test("5. happy path invite calls bskImpl with kind invite and empty body", async () => {
  const fx = fixture("reach:\n  enabled: true\n  linkedin:\n    send_mode: bsk\n");
  const cfg = loadReachConfig(fx);
  writeBskAck(cfg);
  const db = openReachMigratedDb(cfg);
  const personId = seedPerson(db);
  const seen = [];
  await sendApproved(db, cfg, {
    personId, channel: "linkedin", kind: "invite", body: "please connect",
    bskImpl: async (args) => {
      seen.push(args);
      return { pageText: "Invite sent", pageUrl: "https://www.linkedin.com/in/adalovelace" };
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "invite");
  assert.equal(seen[0].body, "");
  db.close();
});
