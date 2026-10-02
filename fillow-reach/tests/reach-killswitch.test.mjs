import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isPaused, pause, resume } from "../lib/reach/killswitch.mjs";

function freshCfg() {
  const dir = mkdtempSync(join(tmpdir(), "reach-killswitch-"));
  return {
    cfg: { paths: { pausePath: join(dir, "reach", "PAUSE") } },
    dir,
  };
}

test("1. fresh dir → isPaused false", () => {
  const { cfg, dir } = freshCfg();
  assert.equal(isPaused(cfg), false);
  rmSync(dir, { recursive: true, force: true });
});

test("2. pause → isPaused true; contents start with an ISO timestamp and include the note", () => {
  const { cfg, dir } = freshCfg();
  pause(cfg, "too many bounces");
  assert.equal(isPaused(cfg), true);
  const contents = readFileSync(cfg.paths.pausePath, "utf8");
  const iso = contents.split("\n")[0].trim();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(!Number.isNaN(Date.parse(iso)));
  assert.ok(contents.includes("too many bounces"));
  rmSync(dir, { recursive: true, force: true });
});

test("3. pause without a note writes just the ISO timestamp", () => {
  const { cfg, dir } = freshCfg();
  pause(cfg);
  assert.equal(isPaused(cfg), true);
  const contents = readFileSync(cfg.paths.pausePath, "utf8").trim();
  assert.match(contents, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  rmSync(dir, { recursive: true, force: true });
});

test("4. toggle-between-calls on one cfg instance — no memoization", () => {
  const { cfg, dir } = freshCfg();
  assert.equal(isPaused(cfg), false);
  pause(cfg);
  assert.equal(isPaused(cfg), true);
  resume(cfg);
  assert.equal(isPaused(cfg), false);
  // external writer (another process dropping the file) is seen immediately
  writeFileSync(cfg.paths.pausePath, "external\n", "utf8");
  assert.equal(isPaused(cfg), true);
  rmSync(dir, { recursive: true, force: true });
});

test("5. resume when PAUSE is absent does not throw and stays unpaused", () => {
  const { cfg, dir } = freshCfg();
  assert.doesNotThrow(() => resume(cfg));
  assert.equal(isPaused(cfg), false);
  rmSync(dir, { recursive: true, force: true });
});
