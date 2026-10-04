import { openReachMigratedDb, recordEvent } from "../lib/reach/db.mjs";
import { syncTargets } from "../lib/reach/targets.mjs";
import { searchPeople } from "../lib/reach/provider-people-search.mjs";
import { fetchBravePeople } from "../lib/reach/provider-brave.mjs";
import { fetchGooglePeople } from "../lib/reach/provider-google.mjs";
import { upsertCompany, upsertPerson } from "../lib/reach/people.mjs";
import { personaFromTitle } from "../lib/reach/import-paste.mjs";
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
    const ranked = targetCompanies.map((c) => ({
      ...c,
      people: db.prepare("SELECT COUNT(*) AS n FROM person WHERE company_id=?").get(c.id).n,
    })).sort((a, b) => a.people - b.people || a.id - b.id);

    const hasGoogle = Boolean(cfg.enrichment.googleKey && cfg.enrichment.googleCx);
    const hasBrave = Boolean(cfg.enrichment.braveKey);
    const discovery = {
      provider: hasGoogle ? "google" : hasBrave ? "brave" : null,
      searched: 0,
      imported: 0,
      reason: hasGoogle || hasBrave ? null : "no_key",
    };
    // Unattended/cron path: Google CSE or Brave, never bsk. Cap searches per run
    // at the daily invite cap so a 180-company jobs.tsv cannot burn the month.
    const searchBudget = cfg.limits.invitesPerDay;

    for (const c of ranked) {
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
            persona: personaFromTitle(d.title),
            source: d.source,
            agent: "prospect",
          });
        } catch { /* bad draft, skip */ }
      }

      if (discovery.searched >= searchBudget || discovery.reason === "quota") continue;
      try {
        let hit = null;
        if (hasGoogle && !cooldown.has("google")) {
          hit = await fetchGooglePeople(db, cfg, { company: c.name, fetchImpl, cooldown });
          if (hit.reason !== "no_key") discovery.provider = "google";
        } else if (hasBrave && !cooldown.has("brave")) {
          hit = await fetchBravePeople(db, cfg, { company: c.name, fetchImpl, cooldown });
          if (hit.reason !== "no_key") discovery.provider = "brave";
        }
        if (hit && hit.reason !== "no_key") {
          discovery.searched += 1;
          discovery.imported += hit.imported ?? 0;
          if (hit.reason === "quota") discovery.reason = "quota";
        }
      } catch { /* provider failure never blocks the batch */ }
    }

    const q = queueDaily(db, cfg);
    if (q.queued > 0) {
      recordEvent(db, { agent: "prospect", entity: "run", action: "prospect_run", detail: { targets: sync.targets, queued: q.queued } });
    }
    emit("phase.complete", { phase: "prospect", targets: sync.targets, queued: q.queued, skipped: q.skipped, discovery });
    return { targets: sync.targets, queued: q.queued, skipped: q.skipped, discovery };
  } finally {
    db.close();
  }
}
