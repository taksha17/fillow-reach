import { readFileSync, readdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { load } from "js-yaml";
import dotenv from "dotenv";

import { profilePath, PATHS } from "../../../lib/paths.mjs";
import { loadReachConfig, validateReachBlock } from "./config.mjs";
import { openReachDb, MIGRATIONS_DIR } from "./db.mjs";
import { withImap } from "./imap.mjs";
import { isPaused } from "./killswitch.mjs";
import { hasBskAck } from "./bsk-send.mjs";
import { hasLocalGguf, localGgufPath } from "./local-llm.mjs";

const MIN_NODE = [22, 13, 0];

function atLeastMinNode(v) {
  const [maj, min, pat] = v.split(".").map(Number);
  return maj > MIN_NODE[0]
    || (maj === MIN_NODE[0] && min > MIN_NODE[1])
    || (maj === MIN_NODE[0] && min === MIN_NODE[1] && pat >= MIN_NODE[2]);
}

function envLookupFrom(envFile) {
  if (envFile) {
    try {
      const parsed = dotenv.parse(readFileSync(envFile, "utf8"));
      return (k) => parsed[k] || undefined;
    } catch {
      return () => undefined;
    }
  }
  dotenv.config({ path: PATHS.env });
  return (k) => process.env[k] || undefined;
}

function migrationVersions() {
  return readdirSync(fileURLToPath(MIGRATIONS_DIR))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => Number.parseInt(f.split("_")[0], 10))
    .sort((a, b) => a - b);
}

const MAIL_GUIDANCE = "REACH_MAIL_USER/REACH_MAIL_PASSWORD unset (GMAIL_IMAP_USER/GMAIL_APP_PASSWORD fallback also missing)"
  + " — use a Gmail app password, not your login password: it requires 2-Step Verification,"
  + " and on Google Workspace your admin may disable app passwords entirely";

export async function collectDoctorChecks({ profileFile, envFile, dataDir, skipMail = false, whichBsk } = {}) {
  const rows = [];
  const push = (ok, label, detail, warn = false) => rows.push({ ok, warn, label, detail });
  const envLookup = envLookupFrom(envFile ?? process.env.REACH_ENV_FILE);

  // 1–2: runtime prerequisites
  const ver = process.versions.node;
  push(atLeastMinNode(ver), "node", atLeastMinNode(ver)
    ? `v${ver}`
    : `node:sqlite needs Node >= 22.13.0 (unflagged); you have v${ver}`);
  try {
    await import("node:sqlite");
    push(true, "node:sqlite", "importable");
  } catch (err) {
    push(false, "node:sqlite", `import failed: ${err.message}`);
  }

  // 3: profile + reach: block
  const profile = profileFile ?? process.env.REACH_PROFILE_FILE ?? profilePath();
  let reachCfg = null;
  let rawDoc = null;
  let configErr = null;
  try {
    rawDoc = load(await readFile(profile, "utf8")) ?? {};
    if (!("reach" in rawDoc)) {
      configErr = "no reach: block — Run fillow-reach setup to write the reach: block";
    } else {
      validateReachBlock(rawDoc.reach, profile);
    }
  } catch (err) {
    configErr = err.message;
  }
  if (configErr) {
    push(false, "config", configErr);
  } else {
    push(true, "config", `ok (${profile})`);
  }
  try {
    reachCfg = loadReachConfig({
      profileFile: profile,
      envFile: envFile ?? process.env.REACH_ENV_FILE,
      dataDir: dataDir ?? process.env.REACH_DATA_DIR,
    });
  } catch {
    reachCfg = null;
  }
  if (reachCfg && !reachCfg.enabled) {
    push(true, "enabled", "Reach disabled in config — set reach.enabled: true", true);
  }

  // 4: migrations current
  if (!reachCfg) {
    push(false, "migrations", "cannot check — resolve the config row first");
  } else if (!existsSync(reachCfg.paths.dbPath)) {
    push(false, "migrations", `${reachCfg.paths.dbPath} does not exist — run fillow-reach migrate (or reach setup)`);
  } else {
    const db = openReachDb(reachCfg.paths.dbPath);
    try {
      let applied = new Set();
      try {
        applied = new Set(db.prepare("SELECT version FROM schema_version").all().map((r) => r.version));
      } catch { /* no schema_version table yet — everything is pending */ }
      const pending = migrationVersions().filter((v) => !applied.has(v));
      if (pending.length) {
        push(false, "migrations", `pending: ${pending.join(", ")} — run fillow-reach migrate`);
      } else {
        push(true, "migrations", `v${Math.max(...migrationVersions())} (current)`);
      }
    } finally {
      db.close();
    }
  }

  // 5: mail creds (REACH_* then GMAIL_* fallback)
  const user = envLookup("REACH_MAIL_USER") ?? envLookup("GMAIL_IMAP_USER");
  const password = envLookup("REACH_MAIL_PASSWORD") ?? envLookup("GMAIL_APP_PASSWORD");
  const mailConfigured = Boolean(user && password);
  if (mailConfigured) {
    push(true, "mail creds", `configured (${reachCfg?.mail.preset ?? "gmail"} as ${user})`);
  } else {
    push(true, "mail creds", MAIL_GUIDANCE, true);
  }

  // 6: enrichment keys — quota 0 means disabled, so absence is a warning only
  for (const [label, key] of [["hunter", "HUNTER_API_KEY"], ["apollo", "APOLLO_API_KEY"]]) {
    const present = Boolean(envLookup(key));
    push(true, label, present ? "set" : "provider disabled — quota 0", !present);
  }

  // 7: IMAP login probe — the only network call doctor ever makes
  if (skipMail || !mailConfigured) {
    push(true, "imap", "skipped");
  } else {
    const imap = reachCfg?.mail.imap ?? { host: "imap.gmail.com", port: 993 };
    try {
      await withImap(user, password, async () => {}, imap);
      push(true, "imap", `login ok (${imap.host}:${imap.port})`);
    } catch (err) {
      push(false, "imap", `login failed against ${imap.host}:${imap.port}: ${err.message} — ${MAIL_GUIDANCE}`);
    }
  }

  // 8: optional bsk + approval ramp (warn only)
  let bskPresent = false;
  if (typeof whichBsk === "function") {
    bskPresent = Boolean(whichBsk());
  } else {
    try {
      const r = spawnSync("bsk", ["status"], { encoding: "utf8", timeout: 3000 });
      bskPresent = r.status === 0;
    } catch {
      bskPresent = false;
    }
  }
  push(true, "bsk", bskPresent ? "bsk binary found" : "bsk binary missing — queue mode still works", !bskPresent);
  if (reachCfg?.linkedin?.sendMode === "bsk" && !hasBskAck(reachCfg)) {
    push(true, "bsk ack", "send_mode=bsk without BSK_ACK — run reach setup --ack-bsk", true);
  }
  if (reachCfg && reachCfg.approvalMode !== "review") {
    push(true, "approval", `approval_mode=${reachCfg.approvalMode} — sample/auto is opt-in`, true);
  }

  if (reachCfg) {
    if (hasLocalGguf(reachCfg)) {
      push(true, "local llm", `Qwen 1.5B GGUF at ${localGgufPath(reachCfg)}`, false);
    } else {
      push(true, "local llm", "Qwen GGUF missing — run reach setup --pull-llm (~1GB, ~1.5GB RAM)", true);
    }
  }

  return rows;
}

export function renderDoctor(rows, { paused = null, dryRun = null } = {}) {
  const lines = ["fillow Reach — doctor"];
  const w = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    lines.push(`  ${(r.ok ? (r.warn ? "warn" : "ok") : "FAIL").padEnd(5)} ${r.label.padEnd(w)}  ${r.detail}`);
  }
  if (paused !== null) lines.push(`  kill switch: ${paused ? "PAUSED" : "off"}`);
  if (dryRun) lines.push("  DRY RUN ACTIVE");
  return lines.join("\n");
}

export async function doctorMain(argv, { out, opts = {} } = {}) {
  const skipMail = argv.includes("--no-mail");
  const rows = await collectDoctorChecks({ ...opts, skipMail });
  let paused = null;
  let dryRun = null;
  try {
    const cfg = loadReachConfig({
      profileFile: opts.profileFile ?? process.env.REACH_PROFILE_FILE,
      envFile: opts.envFile ?? process.env.REACH_ENV_FILE,
      dataDir: opts.dataDir ?? process.env.REACH_DATA_DIR,
    });
    paused = isPaused(cfg);
    dryRun = cfg.dryRun;
  } catch { /* config failure is already a doctor row */ }
  out(renderDoctor(rows, { paused, dryRun }));
  return rows.some((r) => !r.ok) ? 1 : 0;
}
