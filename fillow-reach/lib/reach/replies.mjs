import { recordEvent } from "./db.mjs";
import { toSqliteTs } from "./facts.mjs";

// PRD §5 R3-2: a reply on either channel ends the sequence. Anything still in
// flight becomes `cancelled`; nothing already sent is rewritten.
const CANCELLABLE = "('draft','needs_approval','approved','queued')";

export function ingestInbound(db, {
  personId, channel, body = "", replyClass = "neutral", threadRef = null,
  runId = null, agent = "outreach", now = new Date(),
} = {}) {
  if (!personId) throw new Error("ingestInbound: personId is required");
  if (channel !== "linkedin" && channel !== "email") {
    throw new Error(`ingestInbound: channel must be linkedin or email, got ${String(channel)}`);
  }
  const ts = toSqliteTs(now);
  let messageId;
  let cancelled = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    messageId = Number(db.prepare(
      "INSERT INTO message (person_id, channel, direction, step, status, body, reply_class, thread_ref)"
      + " VALUES (?, ?, 'in', 1, 'replied', ?, ?, ?)",
    ).run(personId, channel, body, replyClass, threadRef).lastInsertRowid);
    db.prepare("UPDATE person SET lifecycle = 'replied', updated_at = ? WHERE id = ?").run(ts, personId);
    cancelled = db.prepare(
      `UPDATE message SET status = 'cancelled' WHERE person_id = ? AND direction = 'out' AND status IN ${CANCELLABLE}`,
    ).run(personId).changes;
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  recordEvent(db, {
    runId,
    agent,
    entity: "message",
    entityId: messageId,
    action: "reply_received",
    detail: { person_id: personId, channel, reply_class: replyClass, cancelled },
  });
  return { messageId, cancelled, personId, channel };
}