import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

export function openReachDb(dbPath) {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function appliedVersions(db) {
  let rows;
  try {
    rows = db.prepare("SELECT version FROM schema_version").all();
  } catch {
    return new Set();
  }
  return new Set(rows.map((r) => r.version));
}

export function migrateReachDb(db, { migrationsDir = MIGRATIONS_DIR } = {}) {
  const dirPath = migrationsDir instanceof URL ? fileURLToPath(migrationsDir) : migrationsDir;
  const files = readdirSync(dirPath)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const applied = [];
  const have = appliedVersions(db);
  for (const file of files) {
    const version = Number.parseInt(file.split("_")[0], 10);
    if (have.has(version)) continue;
    const sql = readFileSync(join(dirPath, file), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    applied.push(version);
  }
  return { applied };
}

export function openReachMigratedDb(reachCfg) {
  const db = openReachDb(reachCfg.paths.dbPath);
  migrateReachDb(db);
  return db;
}

export const EVENT_ENTITIES = Object.freeze([
  "person", "message", "connection", "email_address", "run", "system",
]);

export function recordEvent(db, {
  runId = null, agent, entity, entityId = null, action, detail = {}, ts,
} = {}) {
  if (!EVENT_ENTITIES.includes(entity)) {
    throw new Error(`recordEvent: unknown entity ${String(entity)} (expected one of ${EVENT_ENTITIES.join(", ")})`);
  }
  const fields = ["run_id", "agent", "entity", "entity_id", "action", "detail"];
  const values = [runId, agent, entity, entityId, action, JSON.stringify(detail ?? {})];
  if (ts !== undefined && ts !== null) {
    fields.unshift("ts");
    values.unshift(new Date(ts).toISOString().slice(0, 19).replace("T", " "));
  }
  const sql = `INSERT INTO event_log (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`;
  return db.prepare(sql).run(...values).lastInsertRowid;
}

export function usageSnapshot(db) {
  const read = (view) => {
    const out = { invite: 0, linkedin_message: 0, email: 0 };
    for (const row of db.prepare(`SELECT action, used FROM ${view}`).all()) {
      if (row.action in out) out[row.action] = row.used;
    }
    return out;
  };
  return { day: read("v_usage_1d"), week: read("v_usage_7d") };
}
