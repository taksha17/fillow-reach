import { existsSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../../../lib/atomic-write.mjs";

export function bskAckPath(reachCfg) {
  return join(reachCfg.paths.reachDir, "BSK_ACK");
}

export function hasBskAck(reachCfg) {
  return existsSync(bskAckPath(reachCfg));
}

export function writeBskAck(reachCfg) {
  writeFileAtomic(
    bskAckPath(reachCfg),
    `${new Date().toISOString()}\nuser accepted LinkedIn ToS risk\n`,
  );
}

export function detectLinkedinHazard(pageText, pageUrl) {
  const text = String(pageText || "");
  if (/captcha|unusual activity|restricted|checkpoint|sorry, we|verify you.?re human/i.test(text)) {
    const m = text.match(/captcha|unusual activity|restricted|checkpoint|sorry, we|verify you.?re human/i);
    return m ? m[0] : "linkedin_warning";
  }
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    if (!(host === "linkedin.com" || host.endsWith(".linkedin.com"))) {
      return `unexpected host ${host}`;
    }
  } catch {
    return "unexpected url";
  }
  return null;
}

export async function sendLinkedinViaBsk({ url, kind, body, bskImpl } = {}) {
  if (typeof bskImpl !== "function") {
    throw new Error("bsk binary missing");
  }
  const result = await bskImpl({
    url,
    kind,
    body: kind === "invite" ? "" : (body ?? ""),
  });
  const pageText = result?.pageText ?? "";
  const pageUrl = result?.pageUrl ?? url;
  const hazard = detectLinkedinHazard(pageText, pageUrl);
  if (hazard) {
    const err = new Error(hazard);
    err.code = "LINKEDIN_HAZARD";
    throw err;
  }
  return { ok: true, pageText, pageUrl };
}
