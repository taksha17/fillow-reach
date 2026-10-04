import { openReachMigratedDb, recordEvent } from "../lib/reach/db.mjs";
import { syncTargets } from "../lib/reach/targets.mjs";
import { searchPeople } from "../lib/reach/provider-people-search.mjs";
import { fetchBravePeople } from "../lib/reach/provider-brave.mjs";
import { upsertCompany, upsertPerson } from "../lib/reach/people.mjs";
import { queueDaily } from "../lib/reach/queue.mjs";

// R1 Prospect agent: jobs.tsv targets -> optional own-key people search ->
// scored, capped invite queue. Queue mode only — nothing is sent here (R1-6:
// bsk sender is M5), and one failing source never blocks the batch (R1-10).
export async function run(cfg, { emit = () => {}, jobs, fetchImpl, cooldown = new Set() } = {}) {
  const db = openReachMigratedDb(cfg);
  try {
    const sync = syncTargets(db, cfg, jobs ? { jobs } : {});
    emit("phase.start", { phase: "targets", targets: sync.targets, upserted: sync.upserted });

    const targetCompanies = db.prepare(
      "SELECT DISTINCT c.id, c.name, c.domain FROM company c JOIN target_role t ON t.company_id=c.id"
    ).all();
    for (const c of targetCompanies) {
      let drafts = [];
      try {
        drafts = await searchPeople(cfg, { company: c.name, domain: c.domain, db, fetchImpl, cooldown });
      } catch { /* provider failure never blocks the batch */ }
      for (const d of drafts) {
        try {
          upsertPerson(db, {
            full_name: d.full_name,
            title: d.title,
            companyId: c.id,
            linkedin_url: d.linkedin_url,
            email: d.email,
            persona: "other",
            source: d.source,
            agent: "prospect",
          });
        } catch { /* bad draft, skip */ }
      }
      // Brave syndication path: LinkedIn objects from the public index — no
      // session, no key'd provider quota. Only when the user set BRAVE_API_KEY.
      try {
        if (cfg.enrichment.braveKey && !cooldown.has("brave")) {
          await fetchBravePeople(db, cfg, { company: c.name, fetchImpl, cooldown });
        }
      } catch { /* provider failure never blocks the batch */ }
    }

    const q = queueDaily(db, cfg);
    if (q.queued > 0) {
      recordEvent(db, { agent: "prospect", entity: "run", action: "prospect_run", detail: { targets: sync.targets, queued: q.queued } });
    }
    emit("phase.complete", { phase: "prospect", targets: sync.targets, queued: q.queued, skipped: q.skipped });
    return { targets: sync.targets, queued: q.queued, skipped: q.skipped };
  } finally {
    db.close();
  }
}
