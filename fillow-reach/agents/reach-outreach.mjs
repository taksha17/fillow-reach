import { checkCap } from "../lib/reach/caps.mjs";
import { openReachMigratedDb, recordEvent } from "../lib/reach/db.mjs";
import { composeDraft } from "../lib/reach/draft.mjs";
import { isSuppressed, loadPerson, needsEmailDraft, needsLinkedinDraft, toSqliteTs } from "../lib/reach/facts.mjs";
import { isPaused } from "../lib/reach/killswitch.mjs";
import { sendApproved } from "../lib/reach/send.mjs";

function actionFor(channel) {
  return channel === "linkedin" ? "linkedin_message" : "email";
}

// One person gets at most one composed draft per run. The sequence is
// sequential by design (PRD §5 R3-1/R3-2): an email cannot become eligible
// until the LinkedIn touch has actually been sent and `delay_days` has passed.
function nextTouch(db, cfg, personId, now) {
  if (needsLinkedinDraft(db, personId)) return { channel: "linkedin", step: 1 };
  const emailOpts = {
    delayDays: cfg.email.delayDays,
    followupDays: cfg.email.followupDays,
    requireVerified: cfg.email.requireVerified,
    now,
  };
  if (needsEmailDraft(db, personId, { ...emailOpts, step: 1 })) return { channel: "email", step: 1 };
  if (needsEmailDraft(db, personId, { ...emailOpts, step: 2 })) return { channel: "email", step: 2 };
  return null;
}

// `compose` drafts for everyone eligible. `send` only ever touches rows the
// user has already approved: M3 is review-only, so this agent never promotes a
// draft on its own (PRD §5 R3-7).
export async function run(reachCfg, {
  emit = () => {}, chatImpl, sendMailImpl, compose = true, send = false,
  sleepImpl, now = new Date(), db: injectedDb,
} = {}) {
  emit("phase.start", { agent: "outreach" });
  const db = injectedDb ?? openReachMigratedDb(reachCfg);
  const stats = {
    composed: 0, grounded: 0, ungrounded: 0, composedErrors: 0,
    sent: 0, sendErrors: 0, deferred: 0, skipped: 0, eligible: 0,
  };
  let runId = null;
  try {
    runId = Number(db.prepare(
      "INSERT INTO run (agent, status, dry_run) VALUES ('outreach', 'running', ?)",
    ).run(reachCfg.dryRun ? 1 : 0).lastInsertRowid);

    if (compose) {
      const people = db.prepare("SELECT id FROM person ORDER BY id").all();
      for (const { id } of people) {
        if (isSuppressed(db, loadPerson(db, id))) {
          stats.skipped += 1;
          continue;
        }
        const touch = nextTouch(db, reachCfg, id, now);
        if (!touch) {
          stats.skipped += 1;
          continue;
        }
        stats.eligible += 1;
        try {
          const res = await composeDraft(db, reachCfg, id, touch.channel, {
            chatImpl, step: touch.step, runId, model: null,
          });
          stats.composed += 1;
          if (res.grounding_ok === 1) stats.grounded += 1;
          else stats.ungrounded += 1;
          emit("item.done", {
            personId: id, messageId: res.messageId, channel: touch.channel, step: touch.step,
            grounding_ok: res.grounding_ok,
          });
        } catch (err) {
          // A run-scoped failure (no LLM configured, say) must not abandon the
          // remaining people.
          stats.composedErrors += 1;
          emit("item.done", { personId: id, error: String(err.message || err) });
        }
      }
    }

    if (send) {
      const queue = db.prepare(
        "SELECT id, channel FROM message WHERE direction = 'out' AND status IN ('approved','queued') ORDER BY id",
      ).all();
      for (const row of queue) {
        try {
          const r = await sendApproved(db, reachCfg, row.id, {
            sendMailImpl, sleepImpl, now, runId,
          });
          if (r.status === "sent") stats.sent += 1;
          else if (r.status === "deferred_same_day") stats.deferred += 1;
          emit("item.done", { messageId: row.id, status: r.status });
        } catch (err) {
          stats.sendErrors += 1;
          emit("item.done", { messageId: row.id, error: String(err.message || err) });
          // Over-cap and PAUSE are global: every remaining row would fail the
          // same way, so stop and leave them queued for the next run.
          if (isPaused(reachCfg) || !checkCap({ db, reachCfg, action: actionFor(row.channel) }).ok) break;
        }
      }
    }

    db.prepare("UPDATE run SET finished_at = ?, status = ?, stats = ? WHERE id = ?")
      .run(toSqliteTs(now), stats.sendErrors ? "partial" : "ok", JSON.stringify(stats), runId);
  } catch (err) {
    if (runId) {
      db.prepare("UPDATE run SET finished_at = ?, status = 'failed', stats = ? WHERE id = ?")
        .run(toSqliteTs(now), JSON.stringify({ ...stats, error: String(err.message || err) }), runId);
    }
    try { recordEvent(db, { runId, agent: "outreach", entity: "run", entityId: runId, action: "run_failed", detail: { error: String(err.message || err) } }); } catch { /* audit is best-effort */ }
    emit("phase.complete", { ...stats, error: String(err.message || err) });
    throw err;
  } finally {
    if (!injectedDb) db.close();
  }
  emit("phase.complete", stats);
  return stats;
}