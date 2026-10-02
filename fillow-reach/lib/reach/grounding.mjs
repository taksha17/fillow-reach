// PRD §11/§12: profile text from LinkedIn is data, never an instruction. It is
// handed to the model quoted, with instruction-shaped lines removed.
const INJECTION_LINE = /ignore (all )?(previous|above)|system:|you are now/i;

// A greeting at the start of a message is not a factual claim, so it is dropped
// from the claim set. Everything else that is capitalized mid-sentence is
// treated as a proper noun and must be traceable.
const GREETINGS = new Set([
  "hello", "hi", "hey", "hiya", "dear", "greetings", "good", "quick", "following",
  "thanks", "thank", "morning", "afternoon", "evening", "hope", "reaching",
]);

// Function words, politeness, and generic recruiting vocabulary. The grounding
// check is a lexical trace, so without this list ordinary prose ("I build",
// "would love to") would read as unverified claims.
const STOPWORDS = new Set([
  // articles, prepositions, conjunctions, pronouns, determiners
  "a", "an", "the", "this", "that", "these", "those", "and", "but", "or", "nor",
  "so", "yet", "for", "with", "without", "from", "into", "onto", "upon", "about",
  "above", "below", "over", "under", "between", "among", "through", "during",
  "before", "after", "since", "until", "against", "within", "across", "behind",
  "beyond", "near", "per", "via", "than", "then", "there", "here", "when", "where",
  "which", "who", "whom", "whose", "what", "why", "how", "whether", "if", "unless",
  "while", "because", "although", "though", "also", "just", "very", "really",
  // pronouns / auxiliaries
  "i", "me", "my", "mine", "myself", "we", "us", "our", "ours", "ourselves",
  "you", "your", "yours", "yourself", "yourselves", "he", "him", "his", "she",
  "her", "hers", "it", "its", "they", "them", "their", "theirs", "am", "is",
  "are", "was", "were", "be", "been", "being", "do", "does", "did", "doing",
  "have", "has", "had", "having", "will", "would", "shall", "should", "can",
  "could", "may", "might", "must", "not", "n't", "one", "ones", "something",
  "anything", "nothing", "everything", "someone", "anyone", "everyone",
  // generic recruiting / outreach vocabulary
  "work", "works", "working", "worked", "role", "roles", "team", "teams",
  "company", "companies", "opportunity", "opportunities", "position", "positions",
  "candidate", "candidates", "hire", "hiring", "hire", "recruiter", "recruiting",
  "looking", "interest", "interested", "please", "let", "know", "reach", "reached",
  "message", "messaging", "connect", "connection", "connections", "follow",
  "following", "followup", "email", "emails", "linkedin", "chat", "talk", "call",
  "question", "questions", "note", "notes", "update", "updates", "time", "times",
  "day", "days", "week", "weeks", "month", "months", "year", "years", "today",
  "tomorrow", "later", "soon", "recently", "currently", "first", "second", "next",
  "new", "old", "good", "great", "best", "better", "sure", "happy", "glad",
  "excited", "passionate", "passion", "experience", "experienced", "years",
  "skills", "skill", "ability", "abilities", "strong", "strength", "strengths",
  "workplace", "culture", "mission", "value", "values", "benefit", "benefits",
  "resume", "cv", "portfolio", "website", "profile", "link", "links", "detail",
  "details", "info", "information", "let", "tell", "feel", "felt", "think",
  "thought", "want", "wanted", "need", "needed", "make", "made", "making",
  "took", "take", "taking", "come", "coming", "came", "get", "got", "give",
  "gave", "put", "use", "used", "using", "help", "helped", "love", "loved",
  "enjoy", "enjoyed", "proud", "gladly", "quickly", "easily", "ready",
  "willing", "open", "available", "currently", "free", "time", "kind", "sort",
  "lot", "bit", "really", "much", "many", "more", "most", "less", "least",
  "also", "even", "ever", "never", "always", "often", "sometimes", "usually",
  "etc", "vs", "per", "plus", "minus", "onto", "up", "out", "off", "down",
  "back", "forward", "again", "twice", "half", "double", "single", "other",
  "another", "such", "own", "same", "very", "just", "too", "only", "also",
  // generic work verbs — a claim about *what was built* is checkable, a claim
  // about *doing something* is not a fact about the candidate
  "build", "builds", "building", "built", "create", "creates", "creating",
  "created", "design", "designs", "designing", "designed", "develop", "develops",
  "developing", "developed", "ship", "ships", "shipping", "shipped", "write",
  "writes", "writing", "wrote", "lead", "leads", "leading", "led", "manage",
  "manages", "managing", "managed", "deliver", "delivers", "delivering",
  "delivered", "drive", "drives", "driving", "drove", "run", "runs", "running",
  "ran", "own", "owns", "owning", "owned", "maintain", "maintains", "maintained",
  "support", "supports", "supporting", "supported", "improve", "improves",
  "improving", "improved", "grow", "grows", "growing", "grew", "learn", "learns",
  "learning", "learned", "study", "studies", "studying", "studied", "focus",
  "focuses", "focused", "join", "joins", "joining", "joined", "move", "moves",
  "moving", "moved", "bring", "brings", "bringing", "brought", "want", "wanted",
]);

const CONNECTORS = new Set(["of", "and", "the", "for", "de", "van", "at"]);
const TOKEN_RE = /[A-Za-z][A-Za-z0-9+#]*/g;

// Wrap untrusted profile text as quoted data and drop instruction-shaped lines.
// The model still sees the line's surroundings; it just never sees the injection.
export function sanitizeUntrusted(text) {
  const raw = String(text ?? "");
  const kept = raw
    .split(/\r?\n/)
    .filter((line) => !INJECTION_LINE.test(line))
    .join("\n")
    .trim();
  if (!kept) return "";
  return `"${kept.replace(/"/g, "'")}"`;
}

function isCapitalized(tok) {
  return /^[A-Z]/.test(tok);
}

// An ALL-CAPS token is a technology or initialism, not part of a person's or
// company's name, so it stands alone as its own claim.
function isAcronym(tok) {
  return tok.length >= 2 && tok === tok.toUpperCase() && /^[A-Z]/.test(tok);
}

// Function words that happen to be capitalized mid-sentence ("I", "The") must
// not open or extend a proper-noun run.
function startsRun(tok) {
  return isCapitalized(tok) && !STOPWORDS.has(tok.toLowerCase());
}

// Dashes and semicolons are clause boundaries: without them a vocative followed
// by a dash would fuse into one phrase ("Hi Dana — Python" -> "Dana Python").
function sentences(body) {
  return String(body ?? "")
    .split(/[.!?\n;—–]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Collect the tokens a reader would treat as factual: proper-noun runs and
// long content words. Greetings, function words and stop-listed vocabulary are
// excluded so ordinary prose does not read as an unverified claim.
export function extractClaims(body) {
  const claims = [];
  const seen = new Set();
  const push = (text) => {
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return;
    seen.add(key);
    claims.push(text);
  };

  for (const sentence of sentences(body)) {
    const tokens = sentence.match(TOKEN_RE) ?? [];
    let i = 0;
    while (i < tokens.length) {
      const tok = tokens[i];
      if (startsRun(tok) && !(i === 0 && GREETINGS.has(tok.toLowerCase()))) {
        // absorb a proper-noun run, with lowercase connectors inside it
        const run = [tok];
        let j = i + 1;
        while (j < tokens.length) {
          const next = tokens[j];
          if (isAcronym(next)) break;
          if (startsRun(next)) {
            run.push(next);
            j += 1;
          } else if (CONNECTORS.has(next.toLowerCase())
            && j + 1 < tokens.length
            && startsRun(tokens[j + 1])
            && !isAcronym(tokens[j + 1])) {
            run.push(next);
            j += 1;
          } else break;
        }
        push(run.join(" "));
        i = j;
        continue;
      }
      if (tok.length >= 4) {
        const low = tok.toLowerCase();
        if (!GREETINGS.has(low) && !STOPWORDS.has(low) && !isCapitalized(tok)) push(tok);
      }
      i += 1;
    }
  }
  return claims;
}

// PRD §5 R3-4: every factual claim must trace back to profile/resume text.
// This is a lexical trace, not a semantic one, and it fails closed — an
// unrecognized word blocks the send for human review, which is the safe
// direction for outreach (PRD §13: zero messages sent with grounding_ok = 0).
export function groundingCheck(body, sourcesText) {
  const text = String(body ?? "").trim();
  if (!text) return { ok: false, notes: ["empty draft"] };

  const haystack = String(sourcesText ?? "").toLowerCase();
  if (!haystack) return { ok: false, notes: ["no source text to ground against"] };

  const claims = extractClaims(text);
  const notes = [];
  for (const claim of claims) {
    if (!haystack.includes(claim.toLowerCase())) notes.push(`unverified claim: ${claim}`);
  }
  return { ok: notes.length === 0, notes };
}
