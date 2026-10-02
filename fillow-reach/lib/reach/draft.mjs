import { recordEvent } from "./db.mjs";

// Every draft enters the queue as `needs_approval` with grounding still unset.
// M3 is review-only (PRD §5 R3-7), so there is no path that writes a row
// straight to `approved`; composeDraft is the only other writer and it fills
// grounding_ok in the same call.
export function insertDraft(db, {
  personId, targetId = null, channel, step = 1, subject = null, body,
  templateId = null, model = null, resumeAssetId = null, runId = null, agent = "outreach",
} = {}) {
  if (!personId) throw new Error("insertDraft: personId is required");
  if (channel !== "linkedin" && channel !== "email") {
    throw new Error(`insertDraft: channel must be linkedin or email, got ${String(channel)}`);
  }
  if (!body) throw new Error("insertDraft: body is required");
  const messageId = Number(db.prepare(
    "INSERT INTO message (person_id, target_id, channel, direction, step, status,"
    + " subject, body, template_id, resume_asset_id, model, grounding_ok)"
    + " VALUES (?, ?, ?, 'out', ?, 'needs_approval', ?, ?, ?, ?, ?, NULL)",
  ).run(personId, targetId, channel, step, subject, body, templateId, resumeAssetId, model).lastInsertRowid);
  recordEvent(db, {
    runId,
    agent,
    entity: "message",
    entityId: messageId,
    action: "draft_created",
    detail: { person_id: personId, channel, step },
  });
  return messageId;
}
