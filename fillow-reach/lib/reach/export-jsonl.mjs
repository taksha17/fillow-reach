import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function parseDetail(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function lastExportedId(path) {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return 0;
  try {
    return Number(JSON.parse(lines.at(-1)).id) || 0;
  } catch {
    return 0;
  }
}

export function exportEventsJsonl(db, reachCfg, { date } = {}) {
  const day = date ?? new Date().toISOString().slice(0, 10);
  const dir = reachCfg.paths.eventsDir;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `events-${day}.jsonl`);
  const afterId = lastExportedId(path);
  const rows = db.prepare(
    `SELECT id, ts, run_id, agent, entity, entity_id, action, detail
     FROM event_log
     WHERE date(ts) = ? AND id > ?
     ORDER BY id`,
  ).all(day, afterId);
  let written = 0;
  let payload = "";
  for (const row of rows) {
    payload += `${JSON.stringify({
      id: row.id,
      ts: row.ts,
      run_id: row.run_id,
      agent: row.agent,
      entity: row.entity,
      entity_id: row.entity_id,
      action: row.action,
      detail: parseDetail(row.detail),
    })}\n`;
    written += 1;
  }
  if (payload) appendFileSync(path, payload, "utf8");
  return { path, written };
}
