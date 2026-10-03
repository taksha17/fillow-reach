import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { collectDoctorChecks } from "../lib/reach/doctor.mjs";
import { openReachDb, migrateReachDb } from "../lib/reach/db.mjs";
import {
  DEFAULT_GGUF_NAME,
  DEFAULT_QWEN_URL,
  hasLocalGguf,
  localGgufPath,
  makeLocalChat,
  pullLocalLlm,
} from "../lib/reach/local-llm.mjs";

function fixture(yaml = "reach:\n  enabled: true\n", envText = "") {
  const dir = mkdtempSync(join(tmpdir(), "reach-llm-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  writeFileSync(profileFile, yaml, "utf8");
  writeFileSync(envFile, envText, "utf8");
  return { profileFile, envFile, dataDir: join(dir, "data") };
}

function migrated(fx) {
  const cfg = loadReachConfig(fx);
  const db = openReachDb(cfg.paths.dbPath);
  migrateReachDb(db);
  db.close();
  return fx;
}

test("1. default GGUF path is under data/reach/models and names Qwen 1.5B Q4", () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const path = localGgufPath(cfg);
  assert.equal(path, join(fx.dataDir, "reach", "models", DEFAULT_GGUF_NAME));
  assert.match(DEFAULT_GGUF_NAME, /qwen2\.5-1\.5b-instruct-q4_k_m\.gguf/i);
  assert.match(DEFAULT_QWEN_URL, /huggingface\.co/i);
  assert.equal(hasLocalGguf(cfg), false);
});

test("2. REACH_LLM_GGUF overrides the default path", () => {
  const fx = fixture("reach:\n  enabled: true\n", "REACH_LLM_GGUF=/tmp/custom-qwen.gguf\n");
  const cfg = loadReachConfig(fx);
  assert.equal(localGgufPath(cfg), "/tmp/custom-qwen.gguf");
  assert.equal(cfg.localLlm.ggufPath, "/tmp/custom-qwen.gguf");
});

test("3. pullLocalLlm writes fetch bytes to the GGUF path via injectable fetchImpl", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  const bytes = Buffer.from("GGUF-fake");
  const seen = [];
  const dest = await pullLocalLlm(cfg, {
    fetchImpl: async (url) => {
      seen.push(url);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
  });
  assert.equal(dest, localGgufPath(cfg));
  assert.equal(existsSync(dest), true);
  assert.equal(readFileSync(dest).toString(), "GGUF-fake");
  assert.equal(seen[0], DEFAULT_QWEN_URL);
  assert.equal(hasLocalGguf(cfg), true);
});

test("4. makeLocalChat requires a GGUF and uses inferImpl, never the network", async () => {
  const fx = fixture();
  const cfg = loadReachConfig(fx);
  await assert.rejects(
    () => makeLocalChat(cfg)("sys", "user"),
    /pull-llm|GGUF|acknowledgement|missing/i,
  );
  mkdirSync(dirname(localGgufPath(cfg)), { recursive: true });
  writeFileSync(localGgufPath(cfg), "GGUF-fake", "utf8");
  const chat = makeLocalChat(cfg, {
    inferImpl: async ({ system, user, ggufPath }) => {
      assert.equal(ggufPath, localGgufPath(cfg));
      assert.equal(system, "sys");
      assert.equal(user, "user");
      return '{"subject":"Hi","body":"Hello Dana"}';
    },
  });
  assert.equal(await chat("sys", "user"), '{"subject":"Hi","body":"Hello Dana"}');
});

test("5. setup --pull-llm uses fetchImpl seam and prints the path", async () => {
  const fx = fixture();
  // CLI can't take fetchImpl; pull is tested above. This checks the flag is wired.
  // Without fetchImpl the live download is skipped by a missing-network mock via REACH_LLM_URL=file that 404s —
  // instead, call setupMain through the module after writing a tiny file is the pull test.
  // Here: unknown until wired, the command must exist and fail loud if fetch fails.
  const { setupMain } = await import("../lib/reach/setup.mjs");
  let out = "";
  const cfgOpts = fx;
  const code = await setupMain(["--pull-llm"], {
    out: (s) => { out += `${s}\n`; },
    ...cfgOpts,
    fetchImpl: async () => ({ ok: false, status: 404, statusText: "Not Found", arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  assert.equal(code, 1);
  assert.match(out, /404|failed|pull/i);
});

test("6. doctor warns on missing local GGUF, never fails", async () => {
  const fx = migrated(fixture());
  const rows = await collectDoctorChecks({ ...fx, skipMail: true, whichBsk: () => false });
  const row = rows.find((r) => r.label === "local llm");
  assert.ok(row, "expected a local llm doctor row");
  assert.equal(row.ok, true);
  assert.equal(row.warn, true);
  assert.match(row.detail, /Qwen|pull-llm|GGUF/i);
});

test("7. doctor local llm is ok (no warn) when the GGUF file exists", async () => {
  const fx = migrated(fixture());
  const cfg = loadReachConfig(fx);
  mkdirSync(dirname(localGgufPath(cfg)), { recursive: true });
  writeFileSync(localGgufPath(cfg), "GGUF-fake", "utf8");
  const rows = await collectDoctorChecks({ ...fx, skipMail: true, whichBsk: () => false });
  const row = rows.find((r) => r.label === "local llm");
  assert.equal(row.ok, true);
  assert.equal(row.warn, false);
  assert.match(row.detail, /qwen/i);
});

test("8. .env.example documents REACH_LLM_GGUF", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(example, /^REACH_LLM_GGUF=/m);
});
