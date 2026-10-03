import { assertSendAllowed, healthGuard } from "./caps.mjs";

export function effectiveLimits(db, reachCfg) {
  const limits = { ...reachCfg.limits };
  const { halfTargets } = healthGuard(db, reachCfg);
  if (halfTargets) {
    limits.invitesPerDay = Math.max(1, Math.floor(limits.invitesPerDay / 2));
    limits.emailsPerDay = Math.max(1, Math.floor(limits.emailsPerDay / 2));
  }
  return limits;
}

export function assertSendAllowedHealthy({ db, reachCfg, action, count = 1 } = {}) {
  const health = healthGuard(db, reachCfg);
  if (action === "email" && health.emailPaused) {
    throw new Error("health: email paused — items stay queued");
  }
  return assertSendAllowed({
    db,
    reachCfg: { ...reachCfg, limits: effectiveLimits(db, reachCfg) },
    action,
    count,
  });
}
