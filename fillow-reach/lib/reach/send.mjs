import { recordEvent } from "./db.mjs";
import { toSqliteTs } from "./facts.mjs";

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
