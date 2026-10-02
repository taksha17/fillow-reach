import { existsSync, rmSync } from "node:fs";

import { writeFileAtomic } from "../../../lib/atomic-write.mjs";

// Checked on every call — PAUSE may be dropped by a human or another process
// while a run is in flight; memoizing would defeat the kill switch.
export function isPaused(reachCfg) {
  return existsSync(reachCfg.paths.pausePath);
}

export function pause(reachCfg, note) {
  const lines = [new Date().toISOString()];
  if (note) lines.push(String(note));
  writeFileAtomic(reachCfg.paths.pausePath, `${lines.join("\n")}\n`);
}

export function resume(reachCfg) {
  rmSync(reachCfg.paths.pausePath, { force: true });
}
