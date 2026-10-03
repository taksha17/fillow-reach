import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { upsertCompany } from "./people.mjs";
import { recordEvent } from "./db.mjs";

// jobs.tsv lives in the parent fillow tree; this is the same header-mapped TSV
// read the parent's lib/jobs-tsv.mjs performs, ported read-only so the
// standalone repo needs no file outside fillow-reach/.
export function readJobsTsv(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.length < 2) return [];
  const header = lines[0].split("\t");
  return lines.slice(1)
    .map((line) => {
      const cells = line.split("\t");
      const row = {};
      header.forEach((key, i) => { row[key] = cells[i] ?? ""; });
      return row;
    })
    .filter((row) => (row.source || row.external_id || row.title || row.company));
}

function includeStatus(status) {
  const s = String(status ?? "").trim().toLowerCase();
  return s === "" || s === "ready" || s === "applied";
}

export function syncTargets(db, reachCfg, { jobs, jobsPath, agent = "prospect" } = {}) {
  const list = jobs ?? readJobsTsv(jobsPath ?? join(reachCfg.paths.dataDir, "jobs.tsv"));
  let upserted = 0;
  let skipped = 0;
  for (const job of list) {
    if (!includeStatus(job.status)) { skipped += 1; continue; }
    const jobRef = `${job.source || "unknown"}:${job.external_id || ""}`;
    const companyId = upsertCompany(db, {
      name: job.company,
      linkedin_url: job.url || null,
      ats_source: job.source || null,
    });
    const existing = db.prepare("SELECT id FROM target_role WHERE job_ref=?").get(jobRef);
    if (existing) {
      db.prepare("UPDATE target_role SET title=?, job_url=COALESCE(?, job_url), status=? WHERE id=?")
        .run(job.title || "Untitled role", job.url || null, job.status || null, existing.id);
    } else {
      db.prepare("INSERT INTO target_role (job_ref, title, company_id, job_url, status) VALUES (?,?,?,?,?)")
        .run(jobRef, job.title || "Untitled role", companyId, job.url || null, job.status || null);
    }
    upserted += 1;
    recordEvent(db, { agent, entity: "system", entityId: existing?.id ?? null, action: "target_upserted", detail: { job_ref: jobRef, status: job.status || null } });
  }
  return { targets: list.length, upserted, skipped };
}
