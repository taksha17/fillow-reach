import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { reportDate, buildDailyReport, renderReportText, sendDailyReport } from "../lib/reach/report.mjs";
import { exportEventsJsonl } from "../lib/reach/export-jsonl.mjs";

export async function run(cfg, { emit = () => {}, sendMailImpl, now, send = false } = {}) {
  emit("phase.start", { agent: "report" });
  const db = openReachMigratedDb(cfg);
  try {
    const when = now ?? new Date();
    const date = reportDate(when, cfg.report?.timezone);
    const built = buildDailyReport(db, cfg, { date });
    const text = renderReportText(built);
    let sent = { status: "built", date, rows: built.rows.length };
    if (send) {
      sent = await sendDailyReport(db, cfg, { sendMailImpl, now: when, dryRun: cfg.dryRun });
    }
    const utcDate = reportDate(when, "UTC");
    const exported = exportEventsJsonl(db, cfg, { date: utcDate });
    const out = { date, rows: built.rows.length, text, status: sent.status, exported };
    emit("phase.complete", out);
    return out;
  } finally {
    db.close();
  }
}
