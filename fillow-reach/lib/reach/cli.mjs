import { readFileSync } from "node:fs";

import { loadReachConfig } from "./config.mjs";
import { openReachMigratedDb, recordEvent } from "./db.mjs";
import { isPaused, pause, resume } from "./killswitch.mjs";
import { collectStatus, renderStatus, statusJson, runMigrations } from "./status.mjs";
import { doctorMain } from "./doctor.mjs";
import { setupMain } from "./setup.mjs";
import { importConnectionsCsv } from "./import-connections.mjs";
import { importPaste } from "./import-paste.mjs";
import { addSuppression, forgetPerson } from "./people.mjs";
import { run as runContacts } from "../../agents/reach-contacts.mjs";
import { run as runProspect } from "../../agents/reach-prospect.mjs";
import { approveAllGrounded, approveDraft, listPendingApproval, preview } from "./send.mjs";
import { run as runOutreach } from "../../agents/reach-outreach.mjs";
import { startReachUi } from "./ui.mjs";
import { reportDate, buildDailyReport, renderReportText, sendDailyReport } from "./report.mjs";
import { localLlmStatus, pullLocalLlm, pullLocalRuntime, makeLocalChat } from "./local-llm.mjs";

// Commands registered by later tasks (send/approve/report/...) append a row
// here: { name, summary, run(args, ctx) }. ctx = { cfg, openDb, out }.
// doctor/setup must report config failures as rows, not die on load — raw: true.
export const commands = [
  { name: "status", summary: "usage vs caps, queue sizes, health", run: statusCmd },
  { name: "doctor", summary: "config/migrations/mailbox/keys checks (--no-mail)", run: doctorCmd, raw: true },
  { name: "setup", summary: "guided onboarding wizard (--ack-bsk, --pull-llm)", run: setupCmd, raw: true },
  { name: "pause", summary: "halt all sends — drop a PAUSE kill-switch file", run: pauseCmd },
  { name: "resume", summary: "remove the PAUSE kill-switch file", run: resumeCmd },
  { name: "migrate", summary: "apply pending sqlite migrations", run: migrateCmd },
  { name: "import", summary: "Connections.csv or --paste text (review-first; --yes to write)", run: importCmd },
  { name: "prospect", summary: "sync targets + sources, build capped invite queue", run: prospectCmd },
  { name: "contacts", summary: "detect acceptances/bounces and enrich emails", run: contactsCmd },
  { name: "suppress", summary: "add email, LinkedIn URL, or domain to do-not-contact", run: suppressCmd },
  { name: "forget", summary: "erase a person and cascade derived rows", run: forgetCmd },
  { name: "outreach", summary: "compose drafts for eligible people (--send for approved)", run: outreachCmd },
  { name: "approve", summary: "review drafts (--all-grounded); M3 is review-only", run: approveCmd },
  { name: "ui", summary: "local dashboard on 127.0.0.1:4181", run: uiCmd },
  { name: "report", summary: "build the daily digest (--send to email it)", run: reportCmd },
  { name: "llm", summary: "local Qwen status / --pull / --test", run: llmCmd },
];

// Planned but unregistered: shown in help so the surface is discoverable.
const PLANNED = [];

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

async function setupCmd(args, { out, opts }) {
  return setupMain(args, { out, ...opts });
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
  const { out } = ctx;
  if (args.includes("--paste")) {
    const yes = args.includes("--yes");
    const fileIdx = args.indexOf("--file");
    const file = fileIdx !== -1 ? args[fileIdx + 1] : null;
    const text = file ? readFileSync(file, "utf8") : await readStdinAll();
    const db = ctx.openDb();
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

  const apply = args.includes("--yes");
  const path = args.filter((a) => a !== "--yes").at(-1);
  if (!path) {
    out("usage: reach import [--yes] <connections.csv> | --paste [--file <path>] [--yes]");
    return 1;
  }
  const csvText = readFileSync(path, "utf8");
  const db = ctx.openDb();
  const r = importConnectionsCsv(db, csvText, { apply });
  if (!apply) {
    for (const row of r.preview) {
      out(`${row.full_name} — ${row.title} @ ${row.company} ${row.linkedin_url}`);
    }
    out(`parsed ${r.parsed}, not written (pass --yes)`);
    return 0;
  }
  out(`imported ${r.imported}, skipped ${r.skipped} of ${r.parsed}`);
  return 0;
}

async function prospectCmd(_args, ctx) {
  const { cfg, out } = ctx;
  const res = await runProspect(cfg, { emit: () => {} });
  out(`targets synced: ${res.targets} · invites queued: ${res.queued}${res.skipped ? ` · held back: ${res.skipped}` : ""}`);
  return 0;
}

function suppressKind(value) {
  if (value.includes("@")) return "email";
  if (/linkedin\./i.test(value)) return "linkedin_url";
  return "domain";
}

async function suppressCmd(args, ctx) {
  const value = args[0];
  if (!value) {
    ctx.out("usage: reach suppress <email|linkedin-url|domain>");
    return 1;
  }
  const kind = suppressKind(value);
  addSuppression(ctx.openDb(), { kind, value, reason: "manual" });
  ctx.out(`suppressed ${kind} ${value}`);
  return 0;
}

async function forgetCmd(args, ctx) {
  const id = Number.parseInt(args[0], 10);
  if (!Number.isInteger(id)) {
    ctx.out("usage: reach forget <person-id>");
    return 1;
  }
  const r = forgetPerson(ctx.openDb(), id);
  ctx.out(r.ok ? `forgot person ${id}` : `no person ${id}`);
  return r.ok ? 0 : 1;
}

async function contactsCmd(_args, ctx) {
  const { cfg, out } = ctx;
  if (!cfg.mail.configured) out("mailbox skipped");
  const stats = await runContacts(cfg);
  out(`contacts: accepted ${stats.accepted} unmatched ${stats.unmatched} hard ${stats.hard} soft ${stats.soft} enriched ${stats.enriched}`);
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

// Drafting and sending are deliberately separate steps: `reach outreach`
// composes, `reach approve` is the human gate, `reach outreach --send` delivers
// what was approved. M3 never promotes a draft on its own (PRD §5 R3-7).
async function outreachCmd(args, ctx) {
  const { cfg, out } = ctx;
  const stats = await runOutreach(cfg, { send: args.includes("--send") });
  if (args.includes("--json")) {
    out(JSON.stringify(stats));
    return 0;
  }
  out(
    `outreach: composed ${stats.composed} (${stats.grounded} grounded, ${stats.ungrounded} grounding-failed),`
    + ` skipped ${stats.skipped}`,
  );
  if (stats.composedErrors) out(`${stats.composedErrors} draft(s) failed to compose`);
  if (args.includes("--send")) {
    out(`sent ${stats.sent}, deferred same-day ${stats.deferred}, not sent ${stats.sendErrors}`);
  } else {
    out("review them with: reach approve");
  }
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

async function uiCmd(args, ctx) {
  const { cfg, out } = ctx;
  const { url, port, server } = await startReachUi(cfg, { host: "127.0.0.1", port: 4181 });
  if (args.includes("--json")) out(JSON.stringify({ url, port }));
  else out(url);
  await new Promise((resolve) => server.on("close", resolve));
  return 0;
}

async function reportCmd(args, ctx) {
  const { cfg, out } = ctx;
  const db = ctx.openDb();
  const date = reportDate(new Date(), cfg.report.timezone);
  const built = buildDailyReport(db, cfg, { date });
  out(renderReportText(built));
  if (args.includes("--send")) {
    const r = await sendDailyReport(db, cfg, { now: new Date(), dryRun: cfg.dryRun });
    out(r.status === "sent" ? `sent report ${r.date}` : `dry-run: report built, not sent (${r.date})`);
  }
  return 0;
}

async function llmCmd(args, ctx) {
  const { cfg, out } = ctx;
  const force = args.includes("--force");
  if (args.includes("--pull")) {
    const dest = await pullLocalLlm(cfg, { force });
    out(`wrote ${dest}`);
    try {
      const bin = await pullLocalRuntime(cfg, { force });
      out(`runtime ${bin}`);
    } catch (err) {
      out(`runtime skip: ${err.message}`);
    }
    return 0;
  }
  if (args.includes("--test")) {
    const text = await makeLocalChat(cfg)("Reply with JSON only: {\"ok\": true}", "ping");
    out(text);
    return 0;
  }
  const status = localLlmStatus(cfg);
  if (args.includes("--json")) {
    out(JSON.stringify(status));
    return 0;
  }
  out(`local Qwen (${status.model})`);
  out(`  gguf     ${status.gguf.present ? status.gguf.path : "missing — reach llm --pull"}`);
  out(`  runtime  ${status.runtime.bundled ? status.runtime.path : (status.runtime.present ? "PATH" : "missing — reach llm --pull")}`);
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
