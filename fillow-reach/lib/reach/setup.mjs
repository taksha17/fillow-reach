import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { load } from "js-yaml";
import nodemailer from "nodemailer";

import { writeFileAtomic } from "../../../lib/atomic-write.mjs";
import { PATHS, profilePath } from "../../../lib/paths.mjs";
import { loadReachConfig, REACH_DEFAULTS } from "./config.mjs";
import { openReachDb, migrateReachDb } from "./db.mjs";
import { withImap } from "./imap.mjs";
import { buildReachBlockYaml, writeReachBlock } from "./profile-block.mjs";
import { collectDoctorChecks, renderDoctor } from "./doctor.mjs";
import { writeBskAck, bskAckPath } from "./bsk-send.mjs";

// Append-only .env merge: existing keys are never touched.
export function mergeEnvText(currentText, wanted) {
  const present = new Set();
  for (const line of String(currentText).split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m) present.add(m[1]);
  }
  const added = [];
  let text = String(currentText);
  if (text && !text.endsWith("\n")) text += "\n";
  for (const [key, value] of Object.entries(wanted)) {
    if (present.has(key) || value === undefined || value === "") continue;
    text += `${key}=${value}\n`;
    added.push(key);
  }
  return { text, added };
}

// PRD §9a order; completed steps drop out. acknowledgement stays BEFORE any
// mailbox/enrichment write: §9a makes "nothing written beyond the config
// block" without it, so the wizard must not write .env before consent.
export function planSetupSteps({ hasReachBlock, hasMailCreds, hasEnrichKeys, dbCurrent } = {}) {
  const steps = ["banner", "node"];
  if (!hasReachBlock) steps.push("reach-block");
  steps.push("acknowledge");
  if (!hasMailCreds) steps.push("mailbox");
  if (!hasEnrichKeys) steps.push("enrichment");
  steps.push("caps");
  if (!dbCurrent) steps.push("migrate");
  steps.push("doctor");
  return steps;
}

function defaultPrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q) => (await rl.question(q)).trim();
  ask.close = () => rl.close();
  return ask;
}

const yes = (a) => /^(y|yes)$/i.test(a);

function mask(key, value) {
  return key.toLowerCase().includes("password") || key.toLowerCase().includes("key")
    ? `${key}=${"*".repeat(Math.min(String(value).length, 12))}`
    : `${key}=${value}`;
}

export async function runReachSetup({ prompt, out, envFile, profileFile, dataDir } = {}) {
  const ask = prompt ?? defaultPrompt();
  const say = out ?? ((s = "") => process.stdout.write(`${s}\n`));
  const env = envFile ?? process.env.REACH_ENV_FILE ?? PATHS.env;
  const profile = profileFile ?? process.env.REACH_PROFILE_FILE;
  const data = dataDir ?? process.env.REACH_DATA_DIR;

  let cfg = null;
  let hasReachBlock = false;
  try {
    cfg = loadReachConfig({ profileFile: profile, envFile: env, dataDir: data });
    const doc = load(readFileSync(cfg.profileFile, "utf8")) ?? {};
    hasReachBlock = "reach" in doc;
  } catch { cfg = null; }
  const dbCurrent = (() => {
    try {
      if (!cfg || !existsSync(cfg.paths.dbPath)) return false;
      const db = openReachDb(cfg.paths.dbPath);
      try {
        return db.prepare("SELECT COUNT(*) AS n FROM schema_version").get().n >= 1;
      } finally { db.close(); }
    } catch { return false; }
  })();
  const steps = planSetupSteps({
    hasReachBlock,
    hasMailCreds: Boolean(cfg?.mail.configured),
    hasEnrichKeys: Boolean(cfg?.enrichment.hunterKey || cfg?.enrichment.apolloKey),
    dbCurrent,
  });

  for (const step of steps) {
    if (step === "banner") {
      say("fillow Reach — setup");
      say("Reach drafts and sends LinkedIn outreach and cold email from YOUR accounts, under rolling caps.");
      say("Default mode is dry_run: true — NOTHING sends until you flip reach.dry_run yourself.");
    }

    if (step === "node") {
      const [maj, min, pat] = process.versions.node.split(".").map(Number);
      if (maj < 22 || (maj === 22 && (min < 13 || (min === 13 && pat < 0)))) {
        say(`node:sqlite needs Node >= 22.13.0 (unflagged); you have v${process.versions.node}`);
        return 1;
      }
    }

    if (step === "reach-block") {
      const blockYaml = buildReachBlockYaml(REACH_DEFAULTS);
      say("");
      say("Your profile has no reach: block. This is exactly what will be appended to it:");
      say("");
      say(blockYaml);
      if (!yes(await ask("Write this reach: block to your profile? [y/N] "))) {
        say("No block written — run setup again when ready.");
        if (!prompt) ask.close();
        return 1;
      }
      const target = cfg?.profileFile ?? profile ?? profilePath();
      if (existsSync(target)) {
        writeReachBlock(target, blockYaml);
      } else {
        writeFileAtomic(target, blockYaml);
      }
      say(`Written to ${target}`);
      cfg = loadReachConfig({ profileFile: target, envFile: env, dataDir: data });
    }

    if (step === "acknowledge") {
      say("");
      const a1 = await ask("You are the sender: all outreach goes from your LinkedIn and your mailbox. Understood? [y/N] ");
      const a2 = yes(a1) && await ask("You're responsible for LinkedIn ToS and email-law compliance in your region. Accept? [y/N] ");
      if (!a2) {
        say("Acknowledgement not given — nothing beyond the config block was written. Run setup again when ready.");
        if (!prompt) ask.close();
        return 1;
      }
    }

    if (step === "mailbox") {
      say("");
      say("Mailbox: Reach sends and reads replies through your own mailbox (gmail preset or custom IMAP/SMTP).");
      if (!yes(await ask("Configure mailbox credentials now? [y/N] "))) {
        say("Skipped — mail features stay disabled until REACH_MAIL_USER/REACH_MAIL_PASSWORD are set.");
      } else {
        const preset = (await ask("Preset gmail or custom? [gmail] ")) || "gmail";
        let mail = { preset, ...REACH_DEFAULTS.mail };
        if (preset === "custom") {
          mail = {
            preset,
            imap: { host: await ask("IMAP host: "), port: Number((await ask("IMAP port: [993] ")) || 993) },
            smtp: { host: await ask("SMTP host: "), port: Number((await ask("SMTP port: [465] ")) || 465) },
          };
        }
        const user = await ask("Mail user (your address): ");
        const password = await ask("Mail app password (input hidden from .env display): ");
        const wanted = { REACH_MAIL_USER: user, REACH_MAIL_PASSWORD: password };
        const current = existsSync(env) ? readFileSync(env, "utf8") : "";
        const merged = mergeEnvText(current, wanted);
        say("Will append to .env:");
        for (const k of merged.added) say(`  ${mask(k, wanted[k])}`);
        if (!yes(await ask("Write these to .env? [y/N] "))) {
          say("Skipped .env write.");
        } else {
          writeFileAtomic(env, merged.text);
          say(`Updated ${env}`);
          if (yes(await ask("Test IMAP login + send one self-test email now? [y/N] "))) {
            // The only network sends M0 ever performs (PRD §9a step 1).
            try {
              await withImap(user, password, async () => {}, mail.imap);
              say("IMAP login: ok");
              const tx = nodemailer.createTransport({
                host: mail.smtp.host, port: mail.smtp.port, secure: mail.smtp.port === 465,
                auth: { user, pass: password },
              });
              await tx.sendMail({ from: user, to: user, subject: "fillow Reach setup self-test", text: "Reach is configured. This is the only message setup ever sends." });
              say("SMTP self-send: ok (check your inbox)");
            } catch (err) {
              say(`mailbox test failed: ${err.message}`);
            }
          }
          if (preset === "custom") {
            const targetCfg = loadReachConfig({ profileFile: profile, envFile: env, dataDir: data });
            writeReachBlock(targetCfg.profileFile, buildReachBlockYaml({ ...REACH_DEFAULTS, mail: { preset, imap: mail.imap, smtp: mail.smtp } }));
          }
        }
      }
    }

    if (step === "enrichment") {
      say("");
      say("Enrichment (optional): Hunter and Apollo find verified emails. monthly_quota stays 0 — set it from your plan in reach.enrichment.monthly_quota when ready.");
      const hunter = await ask("HUNTER_API_KEY (empty to skip): ");
      const apollo = await ask("APOLLO_API_KEY (empty to skip): ");
      const wanted = {};
      if (hunter) wanted.HUNTER_API_KEY = hunter;
      if (apollo) wanted.APOLLO_API_KEY = apollo;
      if (Object.keys(wanted).length) {
        const current = existsSync(env) ? readFileSync(env, "utf8") : "";
        const merged = mergeEnvText(current, wanted);
        say("Will append to .env:");
        for (const k of merged.added) say(`  ${mask(k, wanted[k])}`);
        if (yes(await ask("Write these to .env? [y/N] "))) {
          writeFileAtomic(env, merged.text);
          say(`Updated ${env}`);
        }
      } else {
        say("Skipped — the free `pattern` email step still works without keys.");
      }
    }

    if (step === "caps") {
      const L = REACH_DEFAULTS.limits;
      say("");
      say("Default caps (PRD §7):");
      say(`  invites_per_day: ${L.invitesPerDay}   invites_per_7d: ${L.invitesPer7d}`);
      say(`  linkedin_messages_per_7d: ${L.linkedinMessagesPer7d}   emails_per_day: ${L.emailsPerDay}`);
      say(`  pace_seconds: [${L.paceSeconds.join(", ")}]   working_hours: "${L.workingHours}"`);
      if (yes(await ask("Lower any cap now? (raising past defaults requires editing the profile by hand) [y/N] "))) {
        const current = cfg ?? loadReachConfig({ profileFile: profile, envFile: env, dataDir: data });
        const next = { ...current.limits };
        for (const key of ["invitesPerDay", "invitesPer7d", "linkedinMessagesPer7d", "emailsPerDay"]) {
          const v = await ask(`${key} [${next[key]}] `);
          if (v !== "") next[key] = Number(v);
        }
        const raised = ["invitesPerDay", "invitesPer7d", "linkedinMessagesPer7d", "emailsPerDay"]
          .filter((k) => next[k] > L[k]);
        if (raised.length) {
          say(`warning: refusing to raise ${raised.join(", ")} past PRD defaults — edit reach.limits in your profile yourself if you really mean it`);
          for (const k of raised) next[k] = current.limits[k];
        }
        writeReachBlock(current.profileFile, buildReachBlockYaml({ ...current, limits: next }));
        say("reach: block updated.");
      }
    }

    if (step === "migrate") {
      const finalCfg = loadReachConfig({ profileFile: profile, envFile: env, dataDir: data });
      const db = openReachDb(finalCfg.paths.dbPath);
      const { applied } = migrateReachDb(db);
      db.close();
      say(applied.length ? `Database created — applied migrations: ${applied.join(", ")}` : "Database already current.");
    }

    if (step === "doctor") {
      say("");
      const rows = await collectDoctorChecks({ profileFile: profile, envFile: env, dataDir: data, skipMail: true });
      say(renderDoctor(rows));
      say("");
      say("Reach is dry-run. Run fillow-reach doctor any time to diagnose setup.");
    }
  }

  if (!prompt) ask.close();
  return 0;
}

export async function setupMain(argv = [], { out, profileFile, envFile, dataDir } = {}) {
  try {
    if (argv.includes("--ack-bsk")) {
      const cfg = loadReachConfig({ profileFile, envFile, dataDir });
      writeBskAck(cfg);
      out(`wrote ${bskAckPath(cfg)}`);
      return 0;
    }
    return await runReachSetup({ out, profileFile, envFile, dataDir });
  } catch (err) {
    out(`setup failed: ${err.message}`);
    return 1;
  }
}
