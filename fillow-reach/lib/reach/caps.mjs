import { usageSnapshot } from "./db.mjs";
import { isPaused } from "./killswitch.mjs";

// PRD §1 cap table: every action must satisfy each of its windows before a send.
export const CAP_RULES = Object.freeze({
  invite: Object.freeze([
    Object.freeze({ window: "day", capKey: "invitesPerDay" }),
    Object.freeze({ window: "week", capKey: "invitesPer7d" }),
  ]),
  linkedin_message: Object.freeze([
    Object.freeze({ window: "week", capKey: "linkedinMessagesPer7d" }),
  ]),
  email: Object.freeze([
    Object.freeze({ window: "day", capKey: "emailsPerDay" }),
  ]),
});

const WINDOW_WORDS = {
  day: { adj: "daily", span: "in the last 24h", roll: "roll to the next day" },
  week: { adj: "weekly", span: "in the last 7d", roll: "roll to the next week" },
};

export function checkCap({ db, reachCfg, action, count = 1 } = {}) {
  const rules = CAP_RULES[action];
  if (!rules) {
    throw new Error(`checkCap: unknown action ${String(action)} (expected one of ${Object.keys(CAP_RULES).join(", ")})`);
  }
  const usage = usageSnapshot(db);
  let tightest = null; // ok-case: report the window with the least headroom
  for (const { window, capKey } of rules) {
    const used = usage[window][action];
    const cap = reachCfg.limits[capKey];
    if (used + count > cap) {
      return { ok: false, blockedBy: window, used, cap, window };
    }
    if (!tightest || (used + count) / cap > (tightest.used + count) / tightest.cap) {
      tightest = { used, cap, window };
    }
  }
  return { ok: true, blockedBy: null, ...tightest };
}

// PRD §7: over-cap items stay queued — never a write, never a silent drop.
export function assertSendAllowed({ db, reachCfg, action, count = 1 } = {}) {
  if (isPaused(reachCfg)) {
    throw new Error(`Reach is paused — remove ${reachCfg.paths.pausePath} to resume. Items stay queued.`);
  }
  const res = checkCap({ db, reachCfg, action, count });
  if (res.ok) return;
  const w = WINDOW_WORDS[res.blockedBy];
  const what = action.replace(/_/g, " ");
  throw new Error(
    `${w.adj} ${what} cap reached: ${res.used}/${res.cap} ${w.span} — items stay queued and ${w.roll}`,
  );
}

// PRD §7 health guardrails — reports only; callers apply the throttling.
export function healthGuard(db, reachCfg) {
  const invitesSent = db.prepare(
    "SELECT COUNT(*) AS n FROM connection WHERE sent_at >= datetime('now','-14 days')",
  ).get().n;
  const accepted = db.prepare(
    "SELECT COUNT(*) AS n FROM connection WHERE accepted_at >= datetime('now','-14 days')",
  ).get().n;
  const emailsSent = db.prepare(
    "SELECT COUNT(*) AS n FROM message WHERE channel='email' AND direction='out'"
    + " AND sent_at IS NOT NULL AND sent_at >= datetime('now','-14 days')",
  ).get().n;
  const bounced = db.prepare(
    "SELECT COUNT(*) AS n FROM message WHERE channel='email' AND direction='out'"
    + " AND status='bounced' AND sent_at >= datetime('now','-14 days')",
  ).get().n;

  const acceptanceRate14d = invitesSent === 0 ? null : accepted / invitesSent;
  const bounceRate14d = emailsSent === 0 ? null : bounced / emailsSent;
  const { minAcceptance, maxBounce } = reachCfg.health;
  return {
    acceptanceRate14d,
    bounceRate14d,
    halfTargets:
      (acceptanceRate14d !== null && acceptanceRate14d < minAcceptance)
      || (bounceRate14d !== null && bounceRate14d > maxBounce),
    emailPaused: bounceRate14d !== null && bounceRate14d > 0.05, // §7 hard 5% bounce line
  };
}
