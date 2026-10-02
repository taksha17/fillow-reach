import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load } from "js-yaml";

import { loadReachConfig, REACH_DEFAULTS, REACH_YAML_DEFAULTS } from "../lib/reach/config.mjs";

function fixture(profileYaml, envText = "") {
  const dir = mkdtempSync(join(tmpdir(), "reach-cfg-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, profileYaml, "utf8");
  writeFileSync(envFile, envText, "utf8");
  return { profileFile, envFile, dataDir };
}

const CANDIDATE = `candidate:
  first_name: Ada
  last_name: Lovelace
  email: ada@example.com
`;

test("1. profile without reach: block returns full REACH_DEFAULTS shape", () => {
  const f = fixture(CANDIDATE);
  const cfg = loadReachConfig({ ...f });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.dryRunForcedByEnv, false);
  assert.equal(cfg.approvalMode, "review");
  assert.equal(cfg.minRelevance, 70);
  assert.deepEqual(cfg.personas, ["recruiter", "hiring_manager", "senior_ic"]);
  assert.deepEqual(cfg.limits, {
    invitesPerDay: 15,
    invitesPer7d: 75,
    linkedinMessagesPer7d: 75,
    emailsPerDay: 15,
    paceSeconds: [45, 180],
    workingHours: "08:00-18:00",
  });
  assert.deepEqual(cfg.linkedin, { sendMode: "queue", inviteNote: false });
  assert.deepEqual(cfg.email, {
    delayDays: 2,
    followupDays: 7,
    attachResume: "followup",
    requireVerified: true,
    optoutLine: "If you'd rather not hear from me, reply 'stop' and I won't write again.",
  });
  assert.deepEqual(cfg.enrichment.order, ["pattern", "hunter", "apollo"]);
  assert.deepEqual(cfg.enrichment.monthlyQuota, { hunter: 0, apollo: 0 });
  assert.deepEqual(cfg.health, { minAcceptance: 0.25, maxBounce: 0.03 });
  assert.equal(cfg.retentionDays, 180);
  assert.deepEqual(cfg.report, { time: "18:30", timezone: "America/Chicago", attachResumes: true });
  assert.equal(cfg.limits.invitesPerDay, REACH_DEFAULTS.limits.invitesPerDay);
  // invented v1 keys are gone
  for (const k of ["fromName", "fromEmail", "fromDomain", "targetRoles", "windowDays", "smallModel", "qaSamplePct", "contactEvictAfterDays", "caps"]) {
    assert.equal(cfg[k], undefined, `invented key ${k} must not exist`);
  }
  assert.equal(cfg.linkedin.channelsEnabled, undefined);
});

test("2. reach block partial overrides merge with defaults", () => {
  const f = fixture(`${CANDIDATE}reach:
  limits:
    emails_per_day: 5
  mail:
    imap:
      host: imap.fastmail.com
`);
  const cfg = loadReachConfig({ ...f });
  assert.equal(cfg.limits.emailsPerDay, 5);
  assert.equal(cfg.limits.invitesPerDay, 15);
  assert.equal(cfg.mail.imap.host, "imap.fastmail.com");
  assert.equal(cfg.mail.imap.port, 993);
  assert.equal(cfg.mail.smtp.host, "smtp.gmail.com");
  assert.equal(cfg.mail.preset, "gmail");
});

test("3. REACH_DRY_RUN=true env forces dryRun over profile", () => {
  const f = fixture(`${CANDIDATE}reach:
  dry_run: false
`, "REACH_DRY_RUN=true\n");
  const cfg = loadReachConfig({ ...f });
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.dryRunForcedByEnv, true);
});

test("3b. explicit envFile is hermetic: process.env does not leak in", () => {
  const f = fixture(`${CANDIDATE}reach:
  dry_run: false
`, "");
  const prev = process.env.REACH_DRY_RUN;
  process.env.REACH_DRY_RUN = "true";
  try {
    const cfg = loadReachConfig({ ...f });
    assert.equal(cfg.dryRunForcedByEnv, false);
    assert.equal(cfg.dryRun, false);
  } finally {
    if (prev === undefined) delete process.env.REACH_DRY_RUN;
    else process.env.REACH_DRY_RUN = prev;
  }
});

test("4. wrong-typed or out-of-enum values throw naming the offending key", () => {
  const cases = [
    [`reach:\n  limits:\n    emails_per_day: "high"\n`, /limits\.emails_per_day/],
    [`reach:\n  approval_mode: "queue"\n`, /approval_mode/],
    [`reach:\n  linkedin:\n    send_mode: "auto"\n`, /linkedin\.send_mode/],
    [`reach:\n  limits:\n    pace_seconds: [45]\n`, /limits\.pace_seconds/],
    [`reach:\n  email:\n    attach_resume: sometimes\n`, /email\.attach_resume/],
    [`reach:\n  mail:\n    preset: proton\n`, /mail\.preset/],
  ];
  for (const [block, re] of cases) {
    const f = fixture(`${CANDIDATE}${block}`);
    assert.throws(() => loadReachConfig({ ...f }), re, block);
  }
});

test("5. mail creds: GMAIL fallback, REACH_MAIL_* win, configured flag", () => {
  const none = fixture(CANDIDATE, "");
  const cfgNone = loadReachConfig({ ...none });
  assert.equal(cfgNone.mail.user, undefined);
  assert.equal(cfgNone.mail.password, undefined);
  assert.equal(cfgNone.mail.configured, false);

  const gmail = fixture(CANDIDATE, "GMAIL_IMAP_USER=ada@gmail.com\nGMAIL_APP_PASSWORD=gpw\n");
  const cfgGmail = loadReachConfig({ ...gmail });
  assert.equal(cfgGmail.mail.user, "ada@gmail.com");
  assert.equal(cfgGmail.mail.password, "gpw");
  assert.equal(cfgGmail.mail.configured, true);

  const both = fixture(CANDIDATE, "GMAIL_IMAP_USER=ada@gmail.com\nGMAIL_APP_PASSWORD=gpw\nREACH_MAIL_USER=ada@fastmail.com\nREACH_MAIL_PASSWORD=rpw\n");
  const cfgBoth = loadReachConfig({ ...both });
  assert.equal(cfgBoth.mail.user, "ada@fastmail.com");
  assert.equal(cfgBoth.mail.password, "rpw");
  assert.equal(cfgBoth.mail.configured, true);
});

test("6. paths derive from dataDir", () => {
  const f = fixture(CANDIDATE);
  const cfg = loadReachConfig({ ...f });
  assert.equal(cfg.paths.dataDir, f.dataDir);
  assert.equal(cfg.paths.reachDir, join(f.dataDir, "reach"));
  assert.equal(cfg.paths.dbPath, join(f.dataDir, "reach.db"));
  assert.equal(cfg.paths.pausePath, join(f.dataDir, "reach", "PAUSE"));
  assert.equal(cfg.paths.eventsDir, join(f.dataDir, "reach"));
});

test("7. opt-out line, report.time, retentionDays come through verbatim", () => {
  const f = fixture(CANDIDATE);
  const cfg = loadReachConfig({ ...f });
  assert.equal(cfg.email.optoutLine,
    "If you'd rather not hear from me, reply 'stop' and I won't write again.");
  assert.equal(cfg.report.time, "18:30");
  assert.equal(cfg.report.timezone, "America/Chicago");
  assert.equal(cfg.report.attachResumes, true);
  assert.equal(cfg.retentionDays, 180);
});

test("10. .env.example documents every env key the loader reads", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  for (const key of ["REACH_DRY_RUN", "REACH_MAIL_USER", "REACH_MAIL_PASSWORD", "HUNTER_API_KEY", "APOLLO_API_KEY"]) {
    assert.ok(new RegExp(`^${key}=`, "m").test(example), `.env.example missing ${key}`);
  }
});

test("11. config/profile.example.yaml reach block deep-equals the §8 defaults projection", async () => {
  const { buildReachBlockYaml } = await import("../lib/reach/profile-block.mjs");
  const example = load(readFileSync(new URL("../config/profile.example.yaml", import.meta.url), "utf8"));
  assert.deepEqual(example.reach, REACH_YAML_DEFAULTS);
  assert.deepEqual(load(buildReachBlockYaml(REACH_DEFAULTS)).reach, REACH_YAML_DEFAULTS);
});
