import { run as runProspect } from "../../agents/reach-prospect.mjs";
import { run as runContacts } from "../../agents/reach-contacts.mjs";
import { run as runOutreach } from "../../agents/reach-outreach.mjs";
import { openReachMigratedDb } from "./db.mjs";
import { exportEventsJsonl } from "./export-jsonl.mjs";
import { buildDailyReport, renderReportText, reportDate, sendDailyReport } from "./report.mjs";

function errRow(agent, err) {
  return { agent, error: String(err.message || err) };
}

// PRD §9 `reach run`: prospect → contacts → outreach compose → JSONL.
// Sends only when the caller passed `send: true` AND dry_run is off. One
// phase throwing never blocks the rest of the cycle.
export async function runDailyCycle(reachCfg, {
  emit = () => {},
  send = false,
  now = new Date(),
  prospectImpl,
  contactsImpl,
  outreachImpl,
  chatImpl,
  sendMailImpl,
  fetchImpl,
  jobs,
} = {}) {
  const actuallySend = Boolean(send) && !reachCfg.dryRun;
  const stats = {
    prospect: null,
    contacts: null,
    outreach: null,
    jsonl: null,
    report: null,
    errors: [],
    dryRun: reachCfg.dryRun,
    sent: actuallySend,
  };

  emit("phase.start", { agent: "run" });

  const prospectFn = prospectImpl ?? ((cfg, opts) => runProspect(cfg, opts));
  try {
    stats.prospect = await prospectFn(reachCfg, { emit, jobs, fetchImpl });
  } catch (err) {
    stats.errors.push(errRow("prospect", err));
  }

  const contactsFn = contactsImpl ?? ((cfg, opts) => runContacts(cfg, opts));
  try {
    stats.contacts = await contactsFn(reachCfg, { emit, fetchImpl });
  } catch (err) {
    stats.errors.push(errRow("contacts", err));
  }

  const outreachFn = outreachImpl ?? ((cfg, opts) => runOutreach(cfg, opts));
  try {
    stats.outreach = await outreachFn(reachCfg, {
      emit, compose: true, send: actuallySend, chatImpl, sendMailImpl, now,
    });
  } catch (err) {
    stats.errors.push(errRow("outreach", err));
  }

  const db = openReachMigratedDb(reachCfg);
  try {
    try {
      stats.jsonl = exportEventsJsonl(db, reachCfg, { date: now.toISOString().slice(0, 10) });
    } catch (err) {
      stats.errors.push(errRow("jsonl", err));
    }
    try {
      if (actuallySend) {
        stats.report = await sendDailyReport(db, reachCfg, { now, dryRun: reachCfg.dryRun });
      } else {
        const built = buildDailyReport(db, reachCfg, { date: reportDate(now, reachCfg.report.timezone) });
        stats.report = {
          status: "built",
          date: built.date,
          text: renderReportText(built),
        };
      }
    } catch (err) {
      stats.errors.push(errRow("report", err));
    }
  } finally {
    db.close();
  }

  emit("phase.complete", { agent: "run", errors: stats.errors.length });
  return stats;
}
