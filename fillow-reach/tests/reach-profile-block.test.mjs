import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";

import { REACH_DEFAULTS, REACH_YAML_DEFAULTS } from "../lib/reach/config.mjs";
import {
  buildReachBlockYaml,
  upsertReachBlock,
  writeReachBlock,
} from "../lib/reach/profile-block.mjs";

test("1. buildReachBlockYaml(REACH_DEFAULTS) parses to the PRD §8 defaults", () => {
  const blockYaml = buildReachBlockYaml(REACH_DEFAULTS);
  const parsed = load(blockYaml);
  assert.deepEqual(parsed.reach, REACH_YAML_DEFAULTS);
});

test("2. upsert appends the block to a profile that has no reach:", () => {
  const original = "candidate:\n  name: Jane Doe\n";
  const out = upsertReachBlock(original, "reach:\n  enabled: true\n");
  assert.ok(out.startsWith(original));
  assert.ok(out.includes("reach:\n  enabled: true"));
  assert.deepEqual(load(out).candidate, { name: "Jane Doe" });
});

test("3. upsert replaces only the reach: body, preserving keys before AND after (incl. trailing comment)", () => {
  const original = [
    "candidate:",
    "  name: Jane Doe",
    "",
    "reach:",
    "  enabled: false",
    "  invented_key: 1",
    "",
    "runtime:",
    "  quiet: true",
    "# keep this trailing comment",
    "",
  ].join("\n");
  const blockYaml = "reach:\n  enabled: true\n  dry_run: true\n";
  const out = upsertReachBlock(original, blockYaml);
  const parsed = load(out);
  assert.deepEqual(parsed.reach, { enabled: true, dry_run: true });
  assert.deepEqual(parsed.candidate, { name: "Jane Doe" });
  assert.deepEqual(parsed.runtime, { quiet: true });
  assert.ok(out.includes("# keep this trailing comment"));
  assert.ok(!out.includes("invented_key"));
});

test("4. upsert does NOT match a top-level `reacher:` key", () => {
  const original = "reacher:\n  nope: true\n";
  const out = upsertReachBlock(original, "reach:\n  enabled: true\n");
  assert.deepEqual(load(out).reacher, { nope: true });
  assert.deepEqual(load(out).reach, { enabled: true });
});

test("5. writeReachBlock writes atomically and the result parses with non-reach keys unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-block-"));
  const profileFile = join(dir, "profile.yaml");
  writeFileSync(profileFile, "candidate:\n  name: Jane Doe\n", "utf8");
  const res = writeReachBlock(profileFile, buildReachBlockYaml(REACH_DEFAULTS));
  assert.deepEqual(res, { changed: true });
  const parsed = load(readFileSync(profileFile, "utf8"));
  assert.deepEqual(parsed.reach, REACH_YAML_DEFAULTS);
  assert.deepEqual(parsed.candidate, { name: "Jane Doe" });
});

test("6. writeReachBlock leaves the file untouched when the produced doc is invalid", () => {
  const dir = mkdtempSync(join(tmpdir(), "reach-block-"));
  const profileFile = join(dir, "profile.yaml");
  const original = "candidate:\n  name: Jane Doe\n";
  writeFileSync(profileFile, original, "utf8");
  assert.throws(() => writeReachBlock(profileFile, "reach: [unclosed\n  enabled: true\n"));
  assert.equal(readFileSync(profileFile, "utf8"), original);
});
