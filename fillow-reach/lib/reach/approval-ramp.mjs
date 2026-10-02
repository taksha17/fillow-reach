import { recordEvent } from "./db.mjs";

export const N_SAMPLE = 5;
export const N_AUTO = 10;

function wasEdited(db, messageId) {
  const row = db.prepare(
    "SELECT detail FROM event_log WHERE entity = 'message' AND entity_id = ? AND action = 'draft_approved' ORDER BY id DESC LIMIT 1",
  ).get(messageId);
  if (!row?.detail) return false;
  try {
    return Boolean(JSON.parse(row.detail).edited);
  } catch {
    return false;
  }
}

export function consecutiveCleanApprovals(db) {
  const rows = db.prepare(
    "SELECT id, approved_by, grounding_ok FROM message WHERE approved_by IS NOT NULL ORDER BY id DESC",
  ).all();
  let n = 0;
  for (const row of rows) {
    if (row.grounding_ok === 0) break;
    if (row.approved_by !== "user") break;
    if (wasEdited(db, row.id)) break;
    n += 1;
  }
  return n;
}

export function autoApproveAllowed(reachCfg, db, { rngImpl = Math.random } = {}) {
  const mode = reachCfg.approvalMode;
  if (mode === "review" || !mode) return false;
  const latest = db.prepare("SELECT grounding_ok FROM message ORDER BY id DESC LIMIT 1").get();
  if (latest && latest.grounding_ok === 0) return false;
  const n = consecutiveCleanApprovals(db);
  if (mode === "auto") return n >= N_AUTO;
  if (mode === "sample") {
    if (n < N_SAMPLE) return false;
    if (rngImpl() < 0.1) return false;
    return true;
  }
  return false;
}

export function noteDraftGrounding(db, messageId, groundingOk) {
  if (groundingOk === 0) {
    recordEvent(db, {
      agent: "outreach",
      entity: "message",
      entityId: messageId,
      action: "approval_demoted",
      detail: { grounding_ok: 0 },
    });
  }
}

export function maybeAutoApprove(db, reachCfg, messageId, { rngImpl = Math.random } = {}) {
  if (!autoApproveAllowed(reachCfg, db, { rngImpl })) {
    return { status: "needs_approval" };
  }
  db.prepare(
    "UPDATE message SET status = 'approved', approved_by = 'auto', approved_at = datetime('now') WHERE id = ?",
  ).run(messageId);
  recordEvent(db, {
    agent: "outreach",
    entity: "message",
    entityId: messageId,
    action: "draft_auto_approved",
    detail: {},
  });
  return { status: "approved" };
}
