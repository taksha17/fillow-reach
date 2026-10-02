import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { detectAcceptances, detectBounces } from "../lib/reach/acceptance.mjs";
import { enrichEmail } from "../lib/reach/provider-hunter.mjs";
import { purgeExpired } from "../lib/reach/people.mjs";
import { withImap, parseMessage, parseSearchIds } from "../lib/reach/imap.mjs";

function imapSinceDate(days = 14) {
  const d = new Date(Date.now() - days * 86400000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

async function fetchInbox(cfg) {
  const { user, password, imap } = cfg.mail;
  return withImap(user, password, async (session) => {
    await session.command("SELECT INBOX");
    let ids = [];
    try {
      ids = parseSearchIds(await session.command(`UID SEARCH SINCE ${imapSinceDate(14)}`));
    } catch {
      ids = parseSearchIds(await session.command("UID SEARCH ALL"));
    }
    const messages = [];
    for (const id of ids.slice(-50)) {
      const raw = (await session.command(`UID FETCH ${id} (RFC822)`)).join("\n");
      messages.push(parseMessage(raw, id));
    }
    return messages;
  }, imap);
}

function asFetcher(messages) {
  return () => messages;
}

const empty = () => [];

export async function run(cfg, { emit = () => {}, fetcher, bounceFetcher, fetchImpl, cooldown = new Set() } = {}) {
  emit("phase.start", { agent: "contacts" });
  const db = openReachMigratedDb(cfg);
  let acc = { accepted: 0, unmatched: 0 };
  let bnc = { hard: 0, soft: 0 };
  let enriched = 0;
  let skipped = 0;
  try {
    let acceptFetcher = fetcher;
    let bounceFn = bounceFetcher ?? fetcher;
    if (typeof acceptFetcher !== "function") {
      if (cfg.mail?.configured) {
        try {
          const messages = await fetchInbox(cfg);
          acceptFetcher = asFetcher(messages);
          bounceFn = bounceFetcher ?? acceptFetcher;
        } catch (err) {
          emit("item.done", { error: String(err.message || err) });
          acceptFetcher = empty;
          bounceFn = bounceFetcher ?? empty;
        }
      } else {
        acceptFetcher = empty;
        bounceFn = bounceFetcher ?? empty;
      }
    }
    try {
      acc = detectAcceptances(db, cfg, { fetcher: acceptFetcher });
      bnc = detectBounces(db, cfg, { fetcher: bounceFn });
    } catch (err) {
      emit("item.done", { error: String(err.message || err) });
    }
    const people = db.prepare(
      `SELECT p.id FROM person p
       WHERE p.lifecycle IN ('connected','invited')
         AND NOT EXISTS (
           SELECT 1 FROM email_address e WHERE e.person_id = p.id AND e.verification = 'valid'
         )`,
    ).all();
    for (const p of people) {
      const r = await enrichEmail(db, cfg, p.id, { fetchImpl, cooldown });
      if (r?.skipped) skipped += 1;
      else if (r?.email) enriched += 1;
      emit("item.done", { personId: p.id });
    }
    purgeExpired(db, cfg.retentionDays ?? 180);
  } finally {
    db.close();
  }
  const out = { accepted: acc.accepted, unmatched: acc.unmatched, hard: bnc.hard, soft: bnc.soft, enriched, skipped };
  emit("phase.complete", out);
  return out;
}
