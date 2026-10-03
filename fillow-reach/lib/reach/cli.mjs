import { loadReachConfig } from "./config.mjs";
import { openReachMigratedDb, recordEvent } from "./db.mjs";
import { isPaused, pause, resume } from "./killswitch.mjs";
import { collectStatus, renderStatus, statusJson, runMigrations } from "./status.mjs";
import { doctorMain } from "./doctor.mjs";
import { setupMain } from "./setup.mjs";
import { importPaste } from "./import-paste.mjs";
import { readFileSync } from "node:fs";
import { run as runProspect } from "../../agents/reach-prospect.mjs";

// Commands registered by later tasks (import/suppress/forget/...) append a row
// here: { name, summary, run(args, ctx) }. ctx = { cfg, openDb, out }.
// doctor/setup must report config failures as rows, not die on load — raw: true.
export const commands = [
  { name: "status", summary: "usage vs caps, queue sizes, health", run: statusCmd },
  { name: "doctor", summary: "config/migrations/mailbox/keys checks (--no-mail)", run: doctorCmd, raw: true },
  { name: "setup", summary: "guided onboarding wizard (PRD §9a)", run: setupCmd, raw: true },
  { name: "pause", summary: "halt all sends — drop a PAUSE kill-switch file", run: pauseCmd },
  { name: "resume", summary: "remove the PAUSE kill-switch file", run: resumeCmd },
  { name: "migrate", summary: "apply pending sqlite migrations", run: migrateCmd },
  { name: "import", summary: "--paste text (review-first; --yes to write)", run: importCmd },
  { name: "prospect", summary: "sync targets + sources, build capped invite queue", run: prospectCmd },
];

// Planned but unregistered: shown in help so the surface is discoverable.
const PLANNED = [
  { name: "suppress", summary: "(M1+) add a person/domain to the suppression list" },
  { name: "forget", summary: "(M1+) erase a person and all derived data" },
  { name: "send", summary: "(M3+) run one outreach batch (respects caps + PAUSE)" },
  { name: "approve", summary: "(M2+) review drafts" },
  { name: "report", summary: "(M2+) daily digest" },
];

function usageText() {
  const rows = [...commands, ...PLANNED];
  const width = Math.max(...rows.map((r) => r.name.length));
  return [
    "fillow Reach — recruiter outreach agent",
    "",
    "Usage: reach <command> [args] [--json]",
    "",
    ...rows.map((r) => `  reach ${r.name.padEnd(width)}  ${r.summary}`),
    "",
  ].join("\n");
}

function makeOut(stdout) {
  return (s = "") => { stdout.write(`${s}\n`); };
}

function loadCtx(opts) {
  const cfg = loadReachConfig({
    profileFile: opts.profileFile ?? process.env.REACH_PROFILE_FILE,
    envFile: opts.envFile ?? process.env.REACH_ENV_FILE,
    dataDir: opts.dataDir ?? process.env.REACH_DATA_DIR,
  });
  let db;
  return {
    cfg,
    openDb() {
      db ??= openReachMigratedDb(cfg);
      return db;
    },
    closeDb() { db?.close(); db = undefined; },
  };
}

async function statusCmd(args, ctx) {
  const { cfg, out } = ctx;
  const s = collectStatus(cfg);
  if (args.includes("--json")) {
    out(JSON.stringify(statusJson(s)));
    return 0;
  }
  out(renderStatus(s));
  return 0;
}

async function migrateCmd(_args, ctx) {
  const { cfg, out } = ctx;
  const { applied } = runMigrations(cfg);
  out(applied.length
    ? `migrated ${cfg.paths.dbPath} — applied: ${applied.join(", ")}`
    : `already up to date (${cfg.paths.dbPath})`);
  return 0;
}

async function doctorCmd(args, { out, opts }) {
  return doctorMain(args, { out, opts });
}

async function setupCmd(_args, { out, opts }) {
  return setupMain([], { out, ...opts });
}

function readStdinAll() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new Error("no input: pipe text in or pass --file <path>"));
      return;
    }
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { text += c; });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

async function importCmd(args, ctx) {
  const { out, openDb } = ctx;
  if (!args.includes("--paste")) {
    // CSV path behavior belongs to M1 (PR #1); this branch ships paste only.
    out("csv import ships with M1 (PR #1); this build accepts --paste only");
    return 2;
  }
  const yes = args.includes("--yes");
  const fileIdx = args.indexOf("--file");
  const file = fileIdx !== -1 ? args[fileIdx + 1] : null;
  const text = file ? readFileSync(file, "utf8") : await readStdinAll();
  const db = openDb();
  const res = importPaste(db, text, { apply: yes });
  if (!yes) {
    for (const row of res.preview.slice(0, 20)) {
      out(`  ${row.full_name} · ${row.title ?? "?"}${row.company ? ` at ${row.company}` : ""}${row.linkedin_url ? ` · ${row.linkedin_url}` : ""}`);
    }
    out(`parsed ${res.parsed}, not written (pass --yes)`);
    return 0;
  }
  out(`paste imported: ${res.imported}${res.skipped ? `, skipped ${res.skipped}` : ""}`);
  return 0;
}

async function prospectCmd(_args, ctx) {
  const { cfg, out } = ctx;
  const res = await runProspect(cfg, { emit: () => {} });
  out(`targets synced: ${res.targets} · invites queued: ${res.queued}${res.skipped ? ` · held back: ${res.skipped}` : ""}`);
  return 0;
}

async function pauseCmd(args, ctx) {
  const { cfg, out } = ctx;
  const note = args.length ? args.join(" ") : undefined;
  pause(cfg, note);
  try {
    recordEvent(ctx.openDb(), { agent: "cli", entity: "system", action: "pause", detail: { note: note ?? null } });
  } catch { /* audit trail is best-effort; the PAUSE file is the kill switch */ }
  out(`paused — PAUSE written to ${cfg.paths.pausePath}. Items stay queued; nothing sends until 'reach resume'.`);
  return 0;
}

async function resumeCmd(_args, ctx) {
  const { cfg, out } = ctx;
  const was = isPaused(cfg);
  resume(cfg);
  try {
    recordEvent(ctx.openDb(), { agent: "cli", entity: "system", action: "resume", detail: { was } });
  } catch { /* audit trail is best-effort */ }
  out(was ? "resumed — PAUSE removed." : "resumed — no PAUSE file was present.");
  return 0;
}

export async function runReachCli(argv, { stdout = process.stdout, ...opts } = {}) {
  const out = makeOut(stdout);
  const [name, ...args] = argv;
  if (name === "help" || name === "--help" || name === "-h") {
    out(usageText());
    return 0;
  }
  if (!name) {
    out(usageText());
    return 1;
  }
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) {
    out(`unknown command: ${name}`);
    out(usageText());
    return 2;
  }
  let ctx = null;
  if (!cmd.raw) {
    try {
      ctx = loadCtx(opts);
    } catch (err) {
      out(`config error: ${err.message}`);
      return 1;
    }
  }
  try {
    return await cmd.run(args, { ...(ctx ?? {}), out, opts });
  } catch (err) {
    out(`reach ${name}: ${err.message}`);
    return 1;
  } finally {
    ctx?.closeDb();
  }
}
