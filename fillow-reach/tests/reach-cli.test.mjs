import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runReachCli } from "../lib/reach/cli.mjs";
import { loadReachConfig } from "../lib/reach/config.mjs";
import { isPaused } from "../lib/reach/killswitch.mjs";

function fixture(profileYaml = "", envText = "") {
  const dir = mkdtempSync(join(tmpdir(), "reach-cli-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, profileYaml, "utf8");
  writeFileSync(envFile, envText, "utf8");
  return { profileFile, envFile, dataDir };
}

function capture() {
  let out = "";
  return { stdout: { write: (s) => { out += String(s); } }, text: () => out };
}

async function run(argv, fx) {
  const cap = capture();
  const code = await runReachCli(argv, { stdout: cap.stdout, ...fx });
  return { code, out: cap.text() };
}

test("1. empty argv prints usage with all planned commands, exits 1", async () => {
  const fx = fixture();
  const { code, out } = await run([], fx);
  assert.equal(code, 1);
  for (const line of ["reach status", "reach doctor", "reach import", "reach suppress", "reach forget", "reach pause", "reach resume"]) {
    assert.ok(out.includes(line), `usage should mention "${line}"`);
  }
});

test("2. unknown subcommand prints usage, exits 2", async () => {
  const fx = fixture();
  const { code, out } = await run(["boom"], fx);
  assert.equal(code, 2);
  assert.ok(out.includes("reach status"));
  assert.ok(/unknown/i.test(out));
});

test("3. pause then isPaused true; resume clears it", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  assert.equal(isPaused(cfg), false);
  let r = await run(["pause", "manual", "hold"], fx);
  assert.equal(r.code, 0);
  assert.equal(isPaused(cfg), true);
  r = await run(["resume"], fx);
  assert.equal(r.code, 0);
  assert.equal(isPaused(cfg), false);
});

test("4. status on a fresh migrated DB prints usage vs caps", async () => {
  const fx = fixture();
  const { code, out } = await run(["status"], fx);
  assert.equal(code, 0);
  assert.ok(out.includes("invites"));
  assert.ok(out.includes("0/15"), out);
  assert.ok(out.includes("0/75"), out);
  assert.ok(/kill switch :\s+off/i.test(out));
});

test("5. status reflects pause state", async () => {
  const fx = fixture();
  await run(["pause"], fx);
  const { code, out } = await run(["status"], fx);
  assert.equal(code, 0);
  assert.ok(/kill switch :\s+PAUSED/i.test(out));
});

test("6. doctor ok on sane config, exits 0", async () => {
  const fx = fixture("reach:\n  enabled: true\n");
  await run(["migrate"], fx);
  const { code, out } = await run(["doctor", "--no-mail"], fx);
  assert.equal(code, 0, out);
  assert.ok(/config/i.test(out));
});

test("7. doctor reports invalid reach block, exits 1", async () => {
  const fx = fixture("reach:\n  approval_mode: nope\n");
  const { code, out } = await run(["doctor"], fx);
  assert.equal(code, 1);
  assert.ok(/approval_mode/.test(out));
});
