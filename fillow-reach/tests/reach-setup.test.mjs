import test from "node:test";
import assert from "node:assert/strict";

import { mergeEnvText, planSetupSteps } from "../lib/reach/setup.mjs";

test("1. mergeEnvText appends missing keys", () => {
  const { text, added } = mergeEnvText("", { REACH_MAIL_USER: "u@example.com", REACH_MAIL_PASSWORD: "pw" });
  assert.ok(text.includes("REACH_MAIL_USER=u@example.com"));
  assert.ok(text.includes("REACH_MAIL_PASSWORD=pw"));
  assert.deepEqual(added, ["REACH_MAIL_USER", "REACH_MAIL_PASSWORD"]);
});

test("2. mergeEnvText is idempotent — existing keys are never duplicated", () => {
  const once = mergeEnvText("", { REACH_MAIL_USER: "u@example.com" });
  const twice = mergeEnvText(once.text, { REACH_MAIL_USER: "other@example.com", HUNTER_API_KEY: "h" });
  assert.deepEqual(twice.added, ["HUNTER_API_KEY"]);
  assert.equal(twice.text.match(/REACH_MAIL_USER/g).length, 1);
  assert.ok(twice.text.includes("REACH_MAIL_USER=u@example.com"));
});

test("3. mergeEnvText preserves existing content and comments", () => {
  const base = "# my env\nGMAIL_IMAP_USER=g@example.com\n";
  const { text, added } = mergeEnvText(base, { GMAIL_IMAP_USER: "x", HUNTER_API_KEY: "h" });
  assert.deepEqual(added, ["HUNTER_API_KEY"]);
  assert.ok(text.startsWith(base));
  assert.ok(text.endsWith("\n"));
});

test("4. planSetupSteps with nothing done → full §9a order", () => {
  const steps = planSetupSteps({ hasReachBlock: false, hasMailCreds: false, hasEnrichKeys: false, dbCurrent: false });
  assert.deepEqual(steps, ["banner", "node", "reach-block", "acknowledge", "mailbox", "enrichment", "caps", "migrate", "doctor"]);
});

test("5. planSetupSteps with everything done → fixed steps only", () => {
  const steps = planSetupSteps({ hasReachBlock: true, hasMailCreds: true, hasEnrichKeys: true, dbCurrent: true });
  assert.deepEqual(steps, ["banner", "node", "acknowledge", "caps", "doctor"]);
});

test("6. planSetupSteps skips only the completed steps, order preserved", () => {
  const steps = planSetupSteps({ hasReachBlock: true, hasMailCreds: false, hasEnrichKeys: true, dbCurrent: false });
  assert.deepEqual(steps, ["banner", "node", "acknowledge", "mailbox", "caps", "migrate", "doctor"]);
});
