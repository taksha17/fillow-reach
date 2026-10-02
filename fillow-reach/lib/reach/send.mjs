import { recordEvent } from "./db.mjs";
import { pause } from "./killswitch.mjs";
import { hasBskAck, sendLinkedinViaBsk } from "./bsk-send.mjs";
import { assertSendAllowedHealthy } from "./health-apply.mjs";

export async function sendApproved(db, reachCfg, {
  personId, channel, kind = "invite", body = "", bskImpl,
} = {}) {
  const action = channel === "email" ? "email" : (kind === "message" ? "linkedin_message" : "invite");
  assertSendAllowedHealthy({ db, reachCfg, action });
  if (channel === "linkedin" && reachCfg.linkedin?.sendMode === "bsk") {
    if (!hasBskAck(reachCfg)) {
      throw new Error("acknowledgement required — run reach setup --ack-bsk");
    }
    const person = db.prepare("SELECT linkedin_url FROM person WHERE id = ?").get(personId);
    try {
      const result = await sendLinkedinViaBsk({
        url: person?.linkedin_url, kind, body, bskImpl,
      });
      recordEvent(db, { agent: "outreach", entity: "connection", entityId: personId, action: "invite_sent_bsk", detail: { kind } });
      return result;
    } catch (err) {
      if (err.code === "LINKEDIN_HAZARD" || detectAsHazard(err)) {
        pause(reachCfg, String(err.message || err));
        recordEvent(db, { agent: "outreach", entity: "system", action: "linkedin_warning", detail: { message: String(err.message || err) } });
      }
      throw err;
    }
  }
  return { ok: true, queued: true };
}

function detectAsHazard(err) {
  return /captcha|unusual activity|restricted|checkpoint|sorry, we|verify you.?re human|unexpected/i.test(String(err.message || err));
}
