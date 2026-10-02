import { existsSync, readFileSync } from "node:fs";

import { openReachDb, migrateReachDb, usageSnapshot, MIGRATIONS_DIR } from "./db.mjs";
import { healthGuard } from "./caps.mjs";
import { isPaused } from "./killswitch.mjs";

function pad(label) {
  return label.padEnd(12);
}

// Plain one-sentence "what happens next" (PRD §9 status intent).
function nextStep({ paused, dbMissing, dryRun }) {
  if (paused) return "nothing sends while PAUSED — run `reach resume` to continue";
  if (dbMissing) return "run `reach setup` to create the database and write the reach: block";
  if (dryRun) return "dry-run is on — nothing will send until you flip reach.dry_run";
  return "ready to send within caps";
}

export function renderStatus({
  reachCfg, snapshot, paused = false, pausedAt = null, queues = {}, health = {},
  dbVersion = null, dbMissing = false,
} = {}) {
  const L = reachCfg.limits;
  const rows = ["fillow Reach — status"];
  rows.push(`  ${pad("kill switch")}: ${paused ? `PAUSED (since ${pausedAt ?? "unknown"})` : "off"}`);
  const mode = reachCfg.dryRun
    ? `DRY RUN ACTIVE${reachCfg.dryRunForcedByEnv ? " (forced by REACH_DRY_RUN)" : ""}`
    : "LIVE";
  rows.push(`  ${pad("mode")}: ${mode}`);
  rows.push(`  ${pad("schema")}: ${dbVersion === null ? "not created" : `v${dbVersion} (up to date)`}`);
  rows.push(`  ${pad("today")}: invites ${snapshot.day.invite}/${L.invitesPerDay} · emails ${snapshot.day.email}/${L.emailsPerDay}`);
  rows.push(`  ${pad("last 7d")}: invites ${snapshot.week.invite}/${L.invitesPer7d} · linkedin messages ${snapshot.week.linkedin_message}/${L.linkedinMessagesPer7d}`);
  rows.push(`  ${pad("queues")}: ${queues.invitesQueued ?? 0} invites queued · ${queues.draftsAwaitingApproval ?? 0} draft${(queues.draftsAwaitingApproval ?? 0) === 1 ? "" : "s"} awaiting approval`);
  const h = health ?? {};
  rows.push(`  ${pad("health")}: ${h.acceptanceRate14d == null && h.bounceRate14d == null
    ? "no data yet"
    : `acceptance ${Math.round((h.acceptanceRate14d ?? 0) * 100)}% · bounce ${((h.bounceRate14d ?? 0) * 100).toFixed(1)}%`}`);
  rows.push(`  → ${nextStep({ paused, dbMissing, dryRun: reachCfg.dryRun })}`);
  return rows.join("\n");
}

export function collectStatus(reachCfg, { json = false } = {}) {
  const pausedAt = isPaused(reachCfg)
    ? (readFileSync(reachCfg.paths.pausePath, "utf8").split("\n")[0] || null)
    : null;
  const base = {
    reachCfg,
    snapshot: { day: { invite: 0, linkedin_message: 0, email: 0 }, week: { invite: 0, linkedin_message: 0, email: 0 } },
    paused: isPaused(reachCfg),
    pausedAt,
    queues: { invitesQueued: 0, draftsAwaitingApproval: 0 },
    health: { acceptanceRate14d: null, bounceRate14d: null, halfTargets: false, emailPaused: false },
    dbVersion: null,
    dbMissing: !existsSync(reachCfg.paths.dbPath),
  };
  if (base.dbMissing) return base;
  const db = openReachDb(reachCfg.paths.dbPath);
  try {
    const { applied } = migrateReachDb(db);
    void applied; // status migrates proactively so caps/queues never read a stale schema
    base.dbVersion = db.prepare("SELECT MAX(version) AS v FROM schema_version").get().v;
    base.snapshot = usageSnapshot(db);
    base.queues = {
      invitesQueued: db.prepare("SELECT COUNT(*) AS n FROM connection WHERE status='queued'").get().n,
      draftsAwaitingApproval: db.prepare("SELECT COUNT(*) AS n FROM message WHERE status='needs_approval'").get().n,
    };
    base.health = healthGuard(db, reachCfg);
  } finally {
    db.close();
  }
  return base;
}

export function statusJson(s) {
  return {
    dryRun: s.reachCfg.dryRun,
    paused: s.paused,
    today: { invites: s.snapshot.day.invite, emails: s.snapshot.day.email },
    last7d: { invites: s.snapshot.week.invite, linkedinMessages: s.snapshot.week.linkedin_message },
    queues: s.queues,
    health: {
      acceptanceRate14d: s.health.acceptanceRate14d,
      bounceRate14d: s.health.bounceRate14d,
      halfTargets: s.health.halfTargets,
      emailPaused: s.health.emailPaused,
    },
    schemaVersion: s.dbVersion,
  };
}

export function runMigrations(reachCfg) {
  const db = openReachDb(reachCfg.paths.dbPath);
  try {
    return migrateReachDb(db, { migrationsDir: MIGRATIONS_DIR });
  } finally {
    db.close();
  }
}
