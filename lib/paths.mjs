import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");

export const PATHS = {
  root: ROOT,
  profile: join(ROOT, "config", "profile.yaml"),
  profileFallback: join(ROOT, "config.yaml"),
  env: join(ROOT, ".env"),
  envExample: join(ROOT, ".env.example"),
  data: join(ROOT, "data"),
  applications: join(ROOT, "data", "applications.md"),
  blacklist: join(ROOT, "data", "blacklist.md"),
  jobsTsv: join(ROOT, "data", "jobs.tsv"),
  db: join(ROOT, "data", "fillow.db"),
  tailored: join(ROOT, "data", "tailored"),
  reports: join(ROOT, "reports"),
  output: join(ROOT, "output"),
  dashboard: join(ROOT, "output", "dashboard.html"),
  ledger: join(ROOT, "data", "status-ledger.md"),
  coverLetter: join(ROOT, "data", "cover_letter.txt"),
  mghSession: join(ROOT, "data", "mygreenhouse_state.json"),
  boardFlags: join(ROOT, "data", "board-flags.json"),
};

export function ensureDataDirs() {
  for (const dir of [PATHS.data, PATHS.tailored, PATHS.reports, PATHS.output]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function profilePath() {
  if (existsSync(PATHS.profile)) return PATHS.profile;
  if (existsSync(PATHS.profileFallback)) return PATHS.profileFallback;
  return PATHS.profile;
}
