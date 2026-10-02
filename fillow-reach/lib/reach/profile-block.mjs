import { readFileSync } from "node:fs";

import { load } from "js-yaml";

import { writeFileAtomic } from "../../../lib/atomic-write.mjs";
import { REACH_YAML_DEFAULTS } from "./config.mjs";

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

// Accepts either the loaded camelCase reachCfg or a snake_case yaml block.
// Camel input is detected by its marker keys; anything else is treated as
// already yaml-shaped (nested camel values are still tolerated via ?? below).
function toYamlSpace(src) {
  if (!isPlainObj(src)) return {};
  const camel = ["dryRun", "approvalMode", "minRelevance", "retentionDays"].some((k) => k in src)
    || Object.values(src).some((v) => isPlainObj(v) && Object.keys(v).some((k) => /[A-Z]/.test(k)));
  if (!camel) return src;
  const out = {};
  const put = (k, v) => { if (v !== undefined) out[k] = v; };
  const put2 = (obj, k, v) => { if (v !== undefined) obj[k] = v; };
  put("enabled", src.enabled);
  put("dry_run", src.dryRun);
  put("approval_mode", src.approvalMode);
  put("min_relevance", src.minRelevance);
  put("personas", src.personas);
  if (src.limits) {
    out.limits = {};
    put2(out.limits, "invites_per_day", src.limits.invitesPerDay ?? src.limits.invites_per_day);
    put2(out.limits, "invites_per_7d", src.limits.invitesPer7d ?? src.limits.invites_per_7d);
    put2(out.limits, "linkedin_messages_per_7d", src.limits.linkedinMessagesPer7d ?? src.limits.linkedin_messages_per_7d);
    put2(out.limits, "emails_per_day", src.limits.emailsPerDay ?? src.limits.emails_per_day);
    put2(out.limits, "pace_seconds", src.limits.paceSeconds ?? src.limits.pace_seconds);
    put2(out.limits, "working_hours", src.limits.workingHours ?? src.limits.working_hours);
  }
  if (src.linkedin) {
    out.linkedin = {};
    put2(out.linkedin, "send_mode", src.linkedin.sendMode ?? src.linkedin.send_mode);
    put2(out.linkedin, "invite_note", src.linkedin.inviteNote ?? src.linkedin.invite_note);
  }
  if (src.mail) {
    out.mail = {};
    put2(out.mail, "preset", src.mail.preset);
    if (src.mail.imap) out.mail.imap = { host: src.mail.imap.host, port: src.mail.imap.port };
    if (src.mail.smtp) out.mail.smtp = { host: src.mail.smtp.host, port: src.mail.smtp.port };
  }
  if (src.email) {
    out.email = {};
    put2(out.email, "delay_days", src.email.delayDays ?? src.email.delay_days);
    put2(out.email, "followup_days", src.email.followupDays ?? src.email.followup_days);
    put2(out.email, "attach_resume", src.email.attachResume ?? src.email.attach_resume);
    put2(out.email, "require_verified", src.email.requireVerified ?? src.email.require_verified);
    put2(out.email, "optout_line", src.email.optoutLine ?? src.email.optout_line);
  }
  if (src.enrichment) {
    out.enrichment = {};
    put2(out.enrichment, "order", src.enrichment.order ?? undefined);
    const q = src.enrichment.monthlyQuota ?? src.enrichment.monthly_quota;
    if (q) out.enrichment.monthly_quota = { hunter: q.hunter, apollo: q.apollo };
  }
  if (src.health) {
    out.health = {};
    put2(out.health, "min_acceptance", src.health.minAcceptance ?? src.health.min_acceptance);
    put2(out.health, "max_bounce", src.health.maxBounce ?? src.health.max_bounce);
  }
  put("retention_days", src.retentionDays ?? src.retention_days);
  if (src.report) {
    out.report = {};
    put2(out.report, "time", src.report.time);
    put2(out.report, "timezone", src.report.timezone);
    put2(out.report, "attach_resumes", src.report.attachResumes ?? src.report.attach_resumes);
  }
  return out;
}

function flowList(items) {
  return `[${items.join(", ")}]`;
}

// PRD §8 fenced block, values interpolated; comments are part of the spec.
export function buildReachBlockYaml(src) {
  const r = deepMerge(REACH_YAML_DEFAULTS, toYamlSpace(src));
  return `reach:
  enabled: ${r.enabled}
  dry_run: ${r.dry_run}                 # env REACH_DRY_RUN; nothing is sent while true
  approval_mode: ${r.approval_mode}         # review | sample | auto
  min_relevance: ${r.min_relevance}
  personas: ${flowList(r.personas)}
  limits:
    invites_per_day: ${r.limits.invites_per_day}
    invites_per_7d: ${r.limits.invites_per_7d}
    linkedin_messages_per_7d: ${r.limits.linkedin_messages_per_7d}
    emails_per_day: ${r.limits.emails_per_day}
    pace_seconds: ${flowList(r.limits.pace_seconds)}
    working_hours: "${r.limits.working_hours}"
  linkedin:
    send_mode: ${r.linkedin.send_mode}            # queue | bsk
    invite_note: ${r.linkedin.invite_note}          # invites are sent blank
  mail:                         # the user's own mailbox; set by \`fillow reach setup\`
    preset: ${r.mail.preset}               # gmail | custom
    imap: { host: ${r.mail.imap.host}, port: ${r.mail.imap.port} }
    smtp: { host: ${r.mail.smtp.host}, port: ${r.mail.smtp.port} }
    # credentials come from .env, never from this file
  email:
    delay_days: ${r.email.delay_days}
    followup_days: ${r.email.followup_days}
    attach_resume: ${r.email.attach_resume}     # first | followup | never
    require_verified: ${r.email.require_verified}
    optout_line: "${r.email.optout_line}"
  enrichment:
    order: ${flowList(r.enrichment.order)}          # pattern = free built-in step
    monthly_quota: { hunter: ${r.enrichment.monthly_quota.hunter}, apollo: ${r.enrichment.monthly_quota.apollo} }   # 0 = provider disabled; set from YOUR plan
  health: { min_acceptance: ${r.health.min_acceptance}, max_bounce: ${r.health.max_bounce} }
  retention_days: ${r.retention_days}
  report: { time: "${r.report.time}", timezone: "${r.report.timezone}", attach_resumes: ${r.report.attach_resumes} }
`;
}

// Replace the existing top-level reach: block's contiguous body, else append at
// EOF. Indented lines belong to the block; the first unindented line ends it.
export function upsertReachBlock(yamlText, blockYaml) {
  const lines = String(yamlText).split("\n");
  const start = lines.findIndex((l) => /^reach:\s*(#.*)?$/.test(l));
  if (start === -1) {
    const base = yamlText.endsWith("\n") ? yamlText : `${yamlText}\n`;
    return `${base}\n${blockYaml}`;
  }
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end]))) {
    end += 1;
  }
  const next = [...lines.slice(0, start), ...lines.slice(end)];
  const joined = next.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n$/, "");
  return `${joined}\n${blockYaml}`;
}

export function writeReachBlock(profileFile, blockYaml) {
  const original = readFileSync(profileFile, "utf8");
  const next = upsertReachBlock(original, blockYaml);
  // Verify-parse guard: never write a profile that no longer parses.
  load(next);
  writeFileAtomic(profileFile, next);
  return { changed: true };
}
