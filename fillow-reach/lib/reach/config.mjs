import { readFileSync } from "node:fs";
import { join } from "node:path";

import { load } from "js-yaml";
import dotenv from "dotenv";

import { PATHS, profilePath } from "../../../lib/paths.mjs";
import { DEFAULT_GGUF_NAME, DEFAULT_QWEN_URL, llamaCliName } from "./local-llm.mjs";

export const REACH_DEFAULTS = Object.freeze({
  enabled: true,
  dryRun: true,
  approvalMode: "review",
  minRelevance: 70,
  personas: Object.freeze(["recruiter", "hiring_manager", "senior_ic"]),
  limits: Object.freeze({
    invitesPerDay: 15,
    invitesPer7d: 75,
    linkedinMessagesPer7d: 75,
    emailsPerDay: 15,
    paceSeconds: Object.freeze([45, 180]),
    workingHours: "08:00-18:00",
  }),
  linkedin: Object.freeze({ sendMode: "queue", inviteNote: false }),
  mail: Object.freeze({
    preset: "gmail",
    imap: Object.freeze({ host: "imap.gmail.com", port: 993 }),
    smtp: Object.freeze({ host: "smtp.gmail.com", port: 465 }),
  }),
  email: Object.freeze({
    delayDays: 2,
    followupDays: 7,
    attachResume: "followup",
    requireVerified: true,
    optoutLine: "If you'd rather not hear from me, reply 'stop' and I won't write again.",
  }),
  enrichment: Object.freeze({
    order: Object.freeze(["pattern", "hunter", "apollo"]),
    monthlyQuota: Object.freeze({ hunter: 0, apollo: 0 }),
  }),
  health: Object.freeze({ minAcceptance: 0.25, maxBounce: 0.03 }),
  retentionDays: 180,
  report: Object.freeze({ time: "18:30", timezone: "America/Chicago", attachResumes: true }),
});

// PRD §8 reach: block, snake_case yaml space.
export const REACH_YAML_DEFAULTS = Object.freeze({
  enabled: true,
  dry_run: true,
  approval_mode: "review",
  min_relevance: 70,
  personas: ["recruiter", "hiring_manager", "senior_ic"],
  limits: {
    invites_per_day: 15,
    invites_per_7d: 75,
    linkedin_messages_per_7d: 75,
    emails_per_day: 15,
    pace_seconds: [45, 180],
    working_hours: "08:00-18:00",
  },
  linkedin: { send_mode: "queue", invite_note: false },
  mail: {
    preset: "gmail",
    imap: { host: "imap.gmail.com", port: 993 },
    smtp: { host: "smtp.gmail.com", port: 465 },
  },
  email: {
    delay_days: 2,
    followup_days: 7,
    attach_resume: "followup",
    require_verified: true,
    optout_line: "If you'd rather not hear from me, reply 'stop' and I won't write again.",
  },
  enrichment: {
    order: ["pattern", "hunter", "apollo"],
    monthly_quota: { hunter: 0, apollo: 0 },
  },
  health: { min_acceptance: 0.25, max_bounce: 0.03 },
  retention_days: 180,
  report: { time: "18:30", timezone: "America/Chicago", attach_resumes: true },
});

const APPROVAL_MODES = ["review", "sample", "auto"];
const SEND_MODES = ["queue", "bsk"];
const MAIL_PRESETS = ["gmail", "custom"];
const ATTACH_RESUME_MODES = ["first", "followup", "never"];

function isPlainObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isPlainObj(v) && isPlainObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function validateReachBlock(raw, sourceName = "reach") {
  if (!isPlainObj(raw)) {
    throw new Error(`${sourceName}: reach must be a mapping — remove stray reach: values from the yaml and retry.`);
  }
  const bad = (key, want) => {
    throw new Error(`${sourceName}: reach.${key} must be ${want} — fix the reach block (see PRD §8).`);
  };
  for (const k of ["enabled", "dry_run"]) {
    if (raw[k] !== undefined && typeof raw[k] !== "boolean") bad(k, "true or false");
  }
  if (raw.min_relevance !== undefined && typeof raw.min_relevance !== "number") bad("min_relevance", "a number");
  if (raw.retention_days !== undefined && typeof raw.retention_days !== "number") bad("retention_days", "a number");
  if (raw.approval_mode !== undefined && !APPROVAL_MODES.includes(raw.approval_mode)) {
    bad("approval_mode", `one of ${APPROVAL_MODES.join(" | ")}`);
  }
  if (raw.personas !== undefined && (!Array.isArray(raw.personas) || raw.personas.some((p) => typeof p !== "string"))) {
    bad("personas", "a list of strings");
  }
  if (raw.limits !== undefined) {
    if (!isPlainObj(raw.limits)) bad("limits", "a mapping");
    const l = raw.limits;
    for (const k of ["invites_per_day", "invites_per_7d", "linkedin_messages_per_7d", "emails_per_day"]) {
      if (l[k] !== undefined && typeof l[k] !== "number") bad(`limits.${k}`, "a number");
    }
    if (l.pace_seconds !== undefined &&
        (!Array.isArray(l.pace_seconds) || l.pace_seconds.length !== 2 || l.pace_seconds.some((n) => typeof n !== "number"))) {
      bad("limits.pace_seconds", "a two-element list of numbers, e.g. [45, 180]");
    }
    if (l.working_hours !== undefined && typeof l.working_hours !== "string") bad("limits.working_hours", "a string like \"08:00-18:00\"");
  }
  if (raw.linkedin !== undefined) {
    if (!isPlainObj(raw.linkedin)) bad("linkedin", "a mapping");
    if (raw.linkedin.send_mode !== undefined && !SEND_MODES.includes(raw.linkedin.send_mode)) {
      bad("linkedin.send_mode", `one of ${SEND_MODES.join(" | ")}`);
    }
    if (raw.linkedin.invite_note !== undefined && typeof raw.linkedin.invite_note !== "boolean") {
      bad("linkedin.invite_note", "true or false");
    }
  }
  if (raw.mail !== undefined) {
    if (!isPlainObj(raw.mail)) bad("mail", "a mapping");
    if (raw.mail.preset !== undefined && !MAIL_PRESETS.includes(raw.mail.preset)) {
      bad("mail.preset", `one of ${MAIL_PRESETS.join(" | ")}`);
    }
    for (const proto of ["imap", "smtp"]) {
      if (raw.mail[proto] !== undefined) {
        if (!isPlainObj(raw.mail[proto])) bad(`mail.${proto}`, "a mapping");
        const m = raw.mail[proto];
        if (m.host !== undefined && typeof m.host !== "string") bad(`mail.${proto}.host`, "a string");
        if (m.port !== undefined && typeof m.port !== "number") bad(`mail.${proto}.port`, "a number");
      }
    }
  }
  if (raw.email !== undefined) {
    if (!isPlainObj(raw.email)) bad("email", "a mapping");
    for (const k of ["delay_days", "followup_days"]) {
      if (raw.email[k] !== undefined && typeof raw.email[k] !== "number") bad(`email.${k}`, "a number");
    }
    if (raw.email.attach_resume !== undefined && !ATTACH_RESUME_MODES.includes(raw.email.attach_resume)) {
      bad("email.attach_resume", `one of ${ATTACH_RESUME_MODES.join(" | ")}`);
    }
    if (raw.email.require_verified !== undefined && typeof raw.email.require_verified !== "boolean") {
      bad("email.require_verified", "true or false");
    }
    if (raw.email.optout_line !== undefined && typeof raw.email.optout_line !== "string") {
      bad("email.optout_line", "a string");
    }
  }
  if (raw.enrichment !== undefined) {
    if (!isPlainObj(raw.enrichment)) bad("enrichment", "a mapping");
    if (raw.enrichment.order !== undefined && !Array.isArray(raw.enrichment.order)) {
      bad("enrichment.order", "a list");
    }
    if (raw.enrichment.monthly_quota !== undefined) {
      if (!isPlainObj(raw.enrichment.monthly_quota)) bad("enrichment.monthly_quota", "a mapping");
      for (const [k, v] of Object.entries(raw.enrichment.monthly_quota)) {
        if (typeof v !== "number") bad(`enrichment.monthly_quota.${k}`, "a number (0 disables the provider)");
      }
    }
  }
  if (raw.health !== undefined) {
    if (!isPlainObj(raw.health)) bad("health", "a mapping");
    for (const k of ["min_acceptance", "max_bounce"]) {
      if (raw.health[k] !== undefined && typeof raw.health[k] !== "number") bad(`health.${k}`, "a number");
    }
  }
  if (raw.report !== undefined) {
    if (!isPlainObj(raw.report)) bad("report", "a mapping");
    for (const k of ["time", "timezone"]) {
      if (raw.report[k] !== undefined && typeof raw.report[k] !== "string") bad(`report.${k}`, "a string");
    }
    if (raw.report.attach_resumes !== undefined && typeof raw.report.attach_resumes !== "boolean") {
      bad("report.attach_resumes", "true or false");
    }
  }
  return raw;
}

function envFromFile(envFile) {
  try {
    return dotenv.parse(readFileSync(envFile, "utf8"));
  } catch {
    return {};
  }
}

// Explicit envFile (tests): hermetic, only the parsed fixture file.
// No envFile (production): dotenv.config on PATHS.env, then process.env.
function makeEnvLookup(envFile) {
  if (envFile) {
    const fileEnv = envFromFile(envFile);
    return (key) => {
      const v = fileEnv[key];
      return v === "" ? undefined : v;
    };
  }
  dotenv.config({ path: PATHS.env });
  return (key) => {
    const v = process.env[key];
    return v === "" ? undefined : v;
  };
}

export function loadReachConfig({ profileFile, envFile, dataDir } = {}) {
  const profile = profileFile ?? profilePath();
  let rawYaml;
  try {
    rawYaml = readFileSync(profile, "utf8");
  } catch (err) {
    throw new Error(`Could not read profile at ${profile}: ${err.message} — pass profileFile or create ${PATHS.profile}.`);
  }
  const raw = load(rawYaml) ?? {};
  const reachRaw = raw.reach ?? {};
  validateReachBlock(reachRaw, profile);
  const merged = deepMerge(REACH_YAML_DEFAULTS, reachRaw);

  const envLookup = makeEnvLookup(envFile);

  const data = dataDir ?? PATHS.data;
  const reachDir = join(data, "reach");

  const envDry = envLookup("REACH_DRY_RUN") === "true";
  const dryRunForcedByEnv = envDry === true;
  const dryRun = (merged.dry_run ?? true) || envDry;

  const user = envLookup("REACH_MAIL_USER") ?? envLookup("GMAIL_IMAP_USER");
  const password = envLookup("REACH_MAIL_PASSWORD") ?? envLookup("GMAIL_APP_PASSWORD");

  return {
    profileFile: profile,
    paths: {
      dataDir: data,
      reachDir,
      dbPath: join(data, "reach.db"),
      pausePath: join(reachDir, "PAUSE"),
      eventsDir: reachDir,
    },
    enabled: merged.enabled ?? true,
    dryRun,
    dryRunForcedByEnv,
    approvalMode: merged.approval_mode,
    minRelevance: merged.min_relevance,
    personas: merged.personas,
    limits: {
      invitesPerDay: merged.limits.invites_per_day,
      invitesPer7d: merged.limits.invites_per_7d,
      linkedinMessagesPer7d: merged.limits.linkedin_messages_per_7d,
      emailsPerDay: merged.limits.emails_per_day,
      paceSeconds: merged.limits.pace_seconds,
      workingHours: merged.limits.working_hours,
    },
    linkedin: {
      sendMode: merged.linkedin.send_mode,
      inviteNote: merged.linkedin.invite_note,
    },
    mail: {
      preset: merged.mail.preset,
      imap: { host: merged.mail.imap.host, port: merged.mail.imap.port },
      smtp: { host: merged.mail.smtp.host, port: merged.mail.smtp.port },
      user,
      password,
      configured: Boolean(user && password),
    },
    email: {
      delayDays: merged.email.delay_days,
      followupDays: merged.email.followup_days,
      attachResume: merged.email.attach_resume,
      requireVerified: merged.email.require_verified,
      optoutLine: merged.email.optout_line,
    },
    enrichment: {
      order: merged.enrichment.order,
      monthlyQuota: {
        hunter: merged.enrichment.monthly_quota.hunter,
        apollo: merged.enrichment.monthly_quota.apollo,
      },
      hunterKey: envLookup("HUNTER_API_KEY"),
      apolloKey: envLookup("APOLLO_API_KEY"),
    },
    health: {
      minAcceptance: merged.health.min_acceptance,
      maxBounce: merged.health.max_bounce,
    },
    retentionDays: merged.retention_days,
    report: {
      time: merged.report.time,
      timezone: merged.report.timezone,
      attachResumes: merged.report.attach_resumes,
    },
    // Derived from env / default path — not a reach: yaml key (PRD §8).
    localLlm: {
      ggufPath: envLookup("REACH_LLM_GGUF") || join(reachDir, "models", DEFAULT_GGUF_NAME),
      url: envLookup("REACH_LLM_URL") || DEFAULT_QWEN_URL,
      llamaBin: envLookup("REACH_LLAMA_BIN") || join(reachDir, "bin", llamaCliName()),
    },
  };
}
