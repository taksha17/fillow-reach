import { REACH_DEFAULTS } from "./config.mjs";

const STOPWORDS = new Set(["the", "a", "an", "of", "at", "and", "or", "for", "to", "in", "with", "on"]);

function tokens(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+#\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

// PRD R1-2: integer 0–100 with stored reasons. Pins: persona-in-config +30,
// title keyword overlap with the target role +25, live target company +25,
// activity within 30 days +10, senior_ic/hiring_manager seniority +10.
export function scorePerson({
  title, persona, companyIsTarget = false, recencyDays = null, targetTitle = null,
  personas = REACH_DEFAULTS.personas,
} = {}) {
  let score = 0;
  const reasons = [];
  if (personas.includes(persona)) {
    score += 30;
    reasons.push(`persona:${persona}`);
  }
  const mine = tokens(title);
  const target = tokens(targetTitle);
  if (mine.length && target.length && mine.some((t) => target.includes(t))) {
    score += 25;
    reasons.push("title-match");
  }
  if (companyIsTarget) {
    score += 25;
    reasons.push("live-target");
  }
  if (recencyDays != null && recencyDays >= 0 && recencyDays <= 30) {
    score += 10;
    reasons.push("recent");
  }
  if (persona === "senior_ic" || persona === "hiring_manager") {
    score += 10;
    reasons.push("seniority");
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}
