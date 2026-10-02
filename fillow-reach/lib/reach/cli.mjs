import { loadReachConfig } from "./config.mjs";
import { openReachMigratedDb, recordEvent } from "./db.mjs";
import { isPaused, pause, resume } from "./killswitch.mjs";
import { collectStatus, renderStatus, statusJson, runMigrations } from "./status.mjs";
import { doctorMain } from "./doctor.mjs";
import { setupMain } from "./setup.mjs";
import { approveAllGrounded, approveDraft, listPendingApproval, preview } from "./send.mjs";

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
  { name: "approve", summary: "review drafts (--all-grounded); M3 is review-only", run: approveCmd },
];

// Planned but unregistered: shown in help so the surface is discoverable.
const PLANNED = [
  { name: "import", summary: "(M1+) parse pasted search results / LinkedIn CSV" },
  { name: "suppress", summary: "(M1+) add a person/domain to the suppression list" },
  { name: "forget", summary: "(M1+) erase a person and all derived data" },
  { name: "send", summary: "(M3+) run one outreach batch (respects caps + PAUSE)" },
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

async function approveCmd(args, ctx) {
  const { out } = ctx;
  const json = args.includes("--json");
  const allGrounded = args.includes("--all-grounded");
  const db = ctx.openDb();

  if (allGrounded) {
    const r = approveAllGrounded(db, { by: "user" });
    if (json) {
      out(JSON.stringify(r));
      return 0;
    }
    out(`approved ${r.approved.length} grounded draft(s): ${r.approved.join(", ") || "none"}`);
    if (r.blocked.length) {
      out(`left ${r.blocked.length} for review (grounding failed or unset): ${r.blocked.join(", ")}`);
    }
    return 0;
  }

  const id = Number.parseInt(args.find((a) => /^\d+$/.test(a)) ?? "", 10);
  if (Number.isInteger(id)) {
    try {
      const r = approveDraft(db, id, { by: "user" });
      out(json ? JSON.stringify(r) : `approved message ${r.messageId}`);
      return 0;
    } catch (err) {
      out(`reach approve: ${err.message}`);
      return 1;
    }
  }

  const pending = listPendingApproval(db);
  if (json) {
    out(JSON.stringify(pending.map((r) => ({ ...r, preview: preview(r) }))));
    return 0;
  }
  if (!pending.length) {
    out("no drafts awaiting approval");
    return 0;
  }
  for (const row of pending) {
    const flag = row.grounding_ok === 1 ? "grounded" : row.grounding_ok === 0 ? "GROUNDING FAILED" : "ungrounded";
    out(`${String(row.id).padStart(5)}  ${row.channel.padEnd(8)} step ${row.step}  ${flag.padEnd(16)}  ${preview(row)}`);
  }
  out("");
  out("approve <id> | approve --all-grounded | approve --json");
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
