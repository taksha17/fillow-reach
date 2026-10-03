import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { recordEvent } from "./db.mjs";
import {
  isSuppressed, loadCandidateFacts, loadPerson, outboundEmail, toSqliteTs, utcDate,
} from "./facts.mjs";
import { pause } from "./killswitch.mjs";
import { hasBskAck, sendLinkedinViaBsk } from "./bsk-send.mjs";
import { assertSendAllowedHealthy } from "./health-apply.mjs";

export function listPendingApproval(db) {
  return db.prepare(
    "SELECT id, person_id, channel, step, subject, body, grounding_ok, grounding_notes, created_at"
    + " FROM message WHERE status = 'needs_approval' ORDER BY id",
  ).all();
}

// PRD §5 R3-7: M3 is `review` only, so this is the single gate between a
// composed draft and the send path. A draft that failed grounding cannot be
// approved at all — the user must edit and recompose it, never wave it through.
export function approveDraft(db, messageId, { by = "user", runId = null, agent = "outreach" } = {}) {
  const msg = db.prepare("SELECT * FROM message WHERE id = ?").get(messageId);
  if (!msg) throw new Error(`approveDraft: no message ${messageId}`);
  if (msg.direction !== "out") throw new Error(`approveDraft: message ${messageId} is inbound`);
  if (msg.status !== "needs_approval") {
    throw new Error(`approveDraft: message ${messageId} is ${msg.status}, not needs_approval`);
  }
  if (msg.grounding_ok === 0) {
    const why = msg.grounding_notes || "no reason recorded";
    throw new Error(
      `approveDraft: message ${messageId} failed grounding (${why}) — edit and recompose it;`
      + " a draft with grounding_ok=0 can never be approved or sent.",
    );
  }
  if (msg.grounding_ok === null) {
    throw new Error(
      `approveDraft: message ${messageId} was never grounded — run it through composeDraft first.`,
    );
  }
  db.prepare("UPDATE message SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?")
    .run(by, toSqliteTs(new Date()), messageId);
  recordEvent(db, {
    runId,
    agent,
    entity: "message",
    entityId: messageId,
    action: "draft_approved",
    detail: { by, channel: msg.channel, step: msg.step },
  });
  return { ok: true, messageId, channel: msg.channel, step: msg.step };
}

// `approve --all-grounded` promotes every draft that passed grounding and
// leaves the failures queued for the user to deal with individually.
export function approveAllGrounded(db, opts = {}) {
  const approved = [];
  const blocked = [];
  for (const row of listPendingApproval(db)) {
    if (row.grounding_ok === 1) {
      approved.push(approveDraft(db, row.id, opts).messageId);
    } else {
      blocked.push(row.id);
    }
  }
  return { approved, blocked };
}

export function preview(row) {
  const first = String(row.body ?? "").replace(/\s+/g, " ").trim();
  return first.length > 160 ? `${first.slice(0, 157)}...` : first;
}

// R3-9: never LinkedIn-message and email the same person on the same UTC day.
export function sameDayConflict(db, personId, channel, now = new Date()) {
  const other = channel === "linkedin" ? "email" : "linkedin";
  return Boolean(db.prepare(
    "SELECT 1 FROM message WHERE person_id = ? AND channel = ? AND direction = 'out'"
    + " AND status = 'sent' AND sent_at IS NOT NULL AND substr(sent_at, 1, 10) = ? LIMIT 1",
  ).get(personId, other, utcDate(now)));
}

export function paceDelayMs(reachCfg, rng = Math.random) {
  const [min, max] = reachCfg.limits.paceSeconds;
  return Math.round((min + rng() * (max - min)) * 1000);
}

// PRD §5 R3-3: the exact resume variant for that role is attached only when the
// configured phase calls for it. `followup` (the default) means not on the
// first cold email.
function resumeAttachment(db, reachCfg, msg) {
  const mode = reachCfg.email.attachResume;
  const wanted = (mode === "followup" && msg.step === 2) || (mode === "first" && msg.step === 1);
  if (!wanted || !msg.resume_asset_id) return null;
  const asset = db.prepare("SELECT path FROM resume_asset WHERE id = ?").get(msg.resume_asset_id);
  if (!asset) return null;
  const path = isAbsolute(asset.path) ? asset.path : join(reachCfg.paths.dataDir, asset.path);
  if (!existsSync(path)) return null;
  return { filename: path.split(/[\\/]/).pop(), path };
}

// nodemailer is imported lazily: the test suite injects sendMailImpl and must
// never load a transport, let alone open a socket.
async function defaultSendMail(reachCfg) {
  const { default: nodemailer } = await import("nodemailer");
  if (!reachCfg.mail.configured) {
    throw new Error("SMTP credentials missing — set REACH_MAIL_USER and REACH_MAIL_PASSWORD in .env");
  }
  const { host, port } = reachCfg.mail.smtp;
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user: reachCfg.mail.user, pass: reachCfg.mail.password },
  });
  return ({ from, to, subject, text, attachments }) => transport.sendMail({
    from, to, subject, text, attachments,
  });
}

function withOptOut(body, optoutLine) {
  const text = String(body ?? "");
  const line = String(optoutLine ?? "").trim();
  if (!line || text.includes(line)) return text;
  return `${text.replace(/\s+$/, "")}\n\n${line}`;
}

function detectAsHazard(err) {
  return /captcha|unusual activity|restricted|checkpoint|sorry, we|verify you.?re human|unexpected/i.test(String(err.message || err));
}

async function driveLinkedinBsk(db, reachCfg, { personId, kind, body, bskImpl } = {}) {
  if (!hasBskAck(reachCfg)) {
    throw new Error("acknowledgement required — run reach setup --ack-bsk");
  }
  const person = db.prepare("SELECT linkedin_url FROM person WHERE id = ?").get(personId);
  try {
    const result = await sendLinkedinViaBsk({
      url: person?.linkedin_url, kind, body, bskImpl,
    });
    recordEvent(db, {
      agent: "outreach",
      entity: "connection",
      entityId: personId,
      action: "invite_sent_bsk",
      detail: { kind },
    });
    return result;
  } catch (err) {
    if (err.code === "LINKEDIN_HAZARD" || detectAsHazard(err)) {
      pause(reachCfg, String(err.message || err));
      recordEvent(db, {
        agent: "outreach",
        entity: "system",
        action: "linkedin_warning",
        detail: { message: String(err.message || err) },
      });
    }
    throw err;
  }
}

// Object form is the M5 invite/bsk seam (`personId` + `channel`). Numeric
// `messageId` is the M3 outbound-message path. Queue remains the default.
export async function sendApproved(db, reachCfg, messageIdOrOpts, opts = {}) {
  if (messageIdOrOpts && typeof messageIdOrOpts === "object") {
    return sendApprovedDirect(db, reachCfg, messageIdOrOpts);
  }
  return sendApprovedMessage(db, reachCfg, messageIdOrOpts, opts);
}

async function sendApprovedDirect(db, reachCfg, {
  personId, channel, kind = "invite", body = "", bskImpl,
} = {}) {
  const action = channel === "email" ? "email" : (kind === "message" ? "linkedin_message" : "invite");
  assertSendAllowedHealthy({ db, reachCfg, action });
  if (channel === "linkedin" && reachCfg.linkedin?.sendMode === "bsk") {
    return driveLinkedinBsk(db, reachCfg, { personId, kind, body, bskImpl });
  }
  return { ok: true, queued: true };
}

// PRD §7: the cap is checked inside the same transaction that records the send.
// A throw here leaves the message approved/queued — over cap items roll over,
// they never fail.
async function sendApprovedMessage(db, reachCfg, messageId, {
  sendMailImpl, now = new Date(), sleepImpl, pace = true, rng = Math.random,
  runId = null, agent = "outreach", bskImpl,
} = {}) {
  const msg = db.prepare("SELECT * FROM message WHERE id = ?").get(messageId);
  if (!msg) throw new Error(`sendApproved: no message ${messageId}`);
  if (msg.direction !== "out") throw new Error(`sendApproved: message ${messageId} is inbound`);
  if (msg.status !== "approved" && msg.status !== "queued") {
    throw new Error(`sendApproved: message ${messageId} is ${msg.status}, not approved or queued`);
  }
  if (msg.grounding_ok === 0) {
    throw new Error(`sendApproved: message ${messageId} has grounding_ok=0 and can never be sent.`);
  }
  if (msg.grounding_ok === null) {
    throw new Error(`sendApproved: message ${messageId} was never grounded.`);
  }

  // Drafts and approvals persist while dry; nothing is transmitted and nothing
  // is marked sent.
  if (reachCfg.dryRun) {
    return { status: "dry_run", messageId, channel: msg.channel };
  }

  // Suppression is re-checked here: it outranks an approval given earlier.
  const person = loadPerson(db, msg.person_id);
  if (isSuppressed(db, person)) {
    db.prepare("UPDATE message SET status = 'cancelled', error = ? WHERE id = ?")
      .run("suppressed before send", messageId);
    recordEvent(db, {
      runId, agent, entity: "message", entityId: messageId, action: "send_cancelled",
      detail: { reason: "suppressed", channel: msg.channel },
    });
    throw new Error(`sendApproved: person ${msg.person_id} is suppressed — message ${messageId} cancelled.`);
  }

  let to = null;
  if (msg.channel === "email") {
    to = outboundEmail(db, msg.person_id, { requireVerified: reachCfg.email.requireVerified });
    if (!to) {
      throw new Error(
        `sendApproved: no verified address for person ${msg.person_id} — nothing is sent to an unverified inbox.`,
      );
    }
  }

  if (sameDayConflict(db, msg.person_id, msg.channel, now)) {
    if (msg.status !== "queued") {
      db.prepare("UPDATE message SET status = 'queued' WHERE id = ?").run(messageId);
    }
    return { status: "deferred_same_day", messageId, channel: msg.channel };
  }

  const action = msg.channel === "linkedin" ? "linkedin_message" : "email";
  if (msg.channel === "linkedin" && reachCfg.linkedin?.sendMode === "bsk") {
    await driveLinkedinBsk(db, reachCfg, {
      personId: msg.person_id, kind: "message", body: msg.body, bskImpl,
    });
  }

  const sentAt = toSqliteTs(now);
  db.exec("BEGIN IMMEDIATE");
  try {
    assertSendAllowedHealthy({ db, reachCfg, action });
    db.prepare("UPDATE message SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?")
      .run(sentAt, messageId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  if (pace && sleepImpl) await sleepImpl(paceDelayMs(reachCfg, rng));

  recordEvent(db, {
    runId, agent, entity: "message", entityId: messageId, action: "message_sent",
    detail: { channel: msg.channel, step: msg.step, at: sentAt },
  });

  if (msg.channel === "linkedin") {
    // send_mode `queue` (PRD §10): the user clicks send in LinkedIn themselves.
    // `bsk` (M5) already drove Chromium above when configured.
    return { status: "sent", messageId, channel: "linkedin" };
  }

  const candidate = loadCandidateFacts(reachCfg);
  const fromName = candidate.name || reachCfg.mail.user;
  const from = reachCfg.mail.user ? `"${fromName}" <${reachCfg.mail.user}>` : fromName;
  const attachment = resumeAttachment(db, reachCfg, msg);
  const send = sendMailImpl ?? (await defaultSendMail(reachCfg));
  try {
    const info = await send({
      from,
      to,
      subject: msg.subject ?? "",
      text: withOptOut(msg.body, reachCfg.email.optoutLine),
      attachments: attachment ? [attachment] : [],
    });
    if (info?.messageId) {
      db.prepare("UPDATE message SET provider_ref = ? WHERE id = ?").run(String(info.messageId), messageId);
    }
  } catch (err) {
    db.prepare("UPDATE message SET status = 'failed', error = ? WHERE id = ?")
      .run(String(err.message ?? err), messageId);
    recordEvent(db, {
      runId, agent, entity: "message", entityId: messageId, action: "send_failed",
      detail: { channel: msg.channel, error: String(err.message ?? err) },
    });
    throw new Error(`sendApproved: SMTP failed for message ${messageId}: ${err.message ?? err}`);
  }
  return { status: "sent", messageId, channel: "email", to };
}
