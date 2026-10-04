# fillow Reach M1 — R2 Contacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Do not recreate the CLI.** `bin/reach.mjs` and `lib/reach/cli.mjs` shipped in M0. Task 1 of an earlier M1 draft told executors to create those files and expect `Cannot find module` — that is how agents got stuck. This plan starts at people plumbing and **appends** rows to the existing `commands` table.

**Goal:** R2 (Contacts & Enrichment): Connections.csv import, Gmail acceptance + bounce detection, Hunter email find+verify, suppression/forget — behind the existing cap/killswitch/event-log layer.

**Architecture:** Helpers under `fillow-reach/lib/reach/`; agent entry `fillow-reach/agents/reach-contacts.mjs` exporting `run(cfg, opts)` with `emit`; CLI rows appended on `commands` in the existing [`lib/reach/cli.mjs`](../../lib/reach/cli.mjs). Parent repo stays read-only.

**Tech Stack:** Node >= 22.13.0 ESM, `node:sqlite`, `node:test`, `node:tls` (existing IMAP). No new dependencies. Hunter uses `globalThis.fetch`.

**Spec:** `fillow-reach/fillow Reach — PRD & Data Schema.md` §5 R2, §6 schema CHECKs, §8 enrichment, §9 CLI (`import` / `suppress` / `forget` / `contacts`), §13 tests, §14 M1 row. Read those sections before writing any code.

## Global Constraints

- All new/modified files live under `fillow-reach/`. Never edit parent `follow/` source. Never recreate `bin/reach.mjs` or rewrite `runReachCli`.
- Caps from PRD §1/§7/§8 verbatim: invites ≤ 15/day and ≤ 75/rolling-7d, LinkedIn messages ≤ 75/7d, emails ≤ 15/day. Do NOT invent numbers.
- M1 has **no sending**. Do not call `assertSendAllowed`. Detection/enrichment may run while paused.
- Every mutation: `recordEvent(db, { agent: "contacts", entity, entityId, action, detail })` from `lib/reach/db.mjs`. CLI control-plane events keep `agent: "cli"` as M0 does.
- Tests: from `fillow-reach/`, `node --disable-warning=ExperimentalWarning --test tests/<file>.mjs`. Never `npm test`.
- Fixtures use fake identities (PRD §9a). LinkedIn text is stored verbatim; it is data, never instructions.
- Suppression always wins (PRD R2-6, §13).
- Import is review-first: without `--yes`, print preview and write nothing (PRD R1-8).
- `persona` CHECK: `recruiter|hiring_manager|senior_ic|executive|other`. CSV imports use `other` unless a title clearly maps (recruiter / talent / sourcer → `recruiter`).
- `source` CHECK for person: `apollo|hunter|job_posting|csv_import|manual|paste_import|public_page`. CSV uses `csv_import`.
- `email_address.source` CHECK: `hunter|apollo|manual|pattern`.

## Review Focus

1. **CSV column-order/quoting** — real LinkedIn exports reorder headers, add BOM, quote commas in Company. Task 2 fixture must include reordered headers + a quoted comma + a BOM.
2. **Acceptance mail format drift** — subject substring `accepted your invitation`; body may be quoted-printable. Task 3 fixture includes a QP-encoded body.
3. **Hunter HTTP 401/402/429** — disable the provider for the run, never fail the agent (PRD R1-10/R2-4). Task 4 stubs each status.
4. **Suppression beats every rule** — suppressed email/domain/linkedin_url blocks upsert, enrichment insert, and acceptance side-effects. Task 5 dedicated test.
5. **Acceptance matching ambiguity** — two people with the same name at different companies: one notification must not flip both. Unique name+company or event `acceptance_unmatched` and skip. Task 3.
6. **Hard vs soft bounce** — 5.x → `verification='invalid'` + suppression `reason:'bounce'`; 4.x → event `bounce_soft` only. Task 3.

## File structure (this milestone)

- Create: `lib/reach/people.mjs`, `lib/reach/import-connections.mjs`, `lib/reach/acceptance.mjs`, `lib/reach/provider-hunter.mjs`, `lib/reach/provider-usage.mjs`, `agents/reach-contacts.mjs`
- Modify: `lib/reach/cli.mjs` (append command rows; remove those names from `PLANNED`)
- Tests: `tests/reach-people.test.mjs`, `tests/reach-import-csv.test.mjs`, `tests/reach-acceptance.test.mjs`, `tests/reach-hunter.test.mjs`, `tests/reach-suppression.test.mjs`, extend `tests/reach-cli.test.mjs` only with new-command smokes

Shipped — do not touch except the `commands`/`PLANNED` append: `bin/reach.mjs`, `lib/reach/{config,db,caps,killswitch,imap,status,doctor,setup}.mjs`.

Hermetic test fixture (same pattern as `tests/reach-cli.test.mjs`): `mkdtemp` + `loadReachConfig({ profileFile, envFile, dataDir })` + `openReachMigratedDb(cfg)`. Never write the user's real `data/reach.db`.

---

### Task 1: Company + person upsert helpers

**Files:**
- Create: `fillow-reach/lib/reach/people.mjs`
- Test: `fillow-reach/tests/reach-people.test.mjs`

**Interfaces:**
- Consumes: `recordEvent` from `lib/reach/db.mjs`; schema tables `company`, `person`, `connection`, `email_address`, `suppression`.
- Produces:
  - `normalizeLinkedinUrl(url) -> string | null` — lowercase; strip `https?://(www.)?`; strip query and trailing slash; empty → null.
  - `normalizeCompanyName(name) -> string` — lowercase, strip punctuation, strip trailing `inc|llc|ltd|corp|co` (word-bounded). This is `company.name_norm`.
  - `upsertCompany(db, { name, domain = null, linkedin_url = null, ats_source = null }) -> number` — company id; dedup on `name_norm`.
  - `upsertPerson(db, { full_name, headline, title, companyId, linkedin_url, location, persona = "other", source, relevance_score = null, relevance_reasons = null, email = null }) -> { personId, created } | null` — dedup PRD R1-3: normalized LinkedIn URL, then email (`email_address`), then fuzzy name+company (`normalizePersonName(full_name)` + `company_id`). If `isSuppressed` on url/email/company domain → return `null` and `recordEvent` action `suppressed_blocked`. New person: split first/last on first space; `lifecycle='prospect'`. Event `person_upserted` with `{ created }`.
  - `normalizePersonName(name) -> string` — lowercase, collapse whitespace.
  - `isSuppressed(db, { email, linkedin_url, domain }) -> boolean` — match `suppression.kind` `email` | `linkedin_url` | `domain` against normalized values (email lowercased; url via `normalizeLinkedinUrl`; domain lowercased).
  - `addSuppression(db, { kind, value, reason }) -> id` — kind ∈ `email|linkedin_url|domain`, reason ∈ `optout|bounce|manual|complaint`. Normalize value the same way. Event `suppressed`.
  - `insertEmailAddress(db, { person_id, email, source, confidence = null, verification = "unknown" }) -> { id, created }` — UNIQUE `(person_id, email)` upsert; set `verified_at` when `verification !== "unknown"`; event `email_stored`. If `isSuppressed` on that email or its domain → return `null`, event `suppressed_blocked`, no row.

- [x] **Step 1: Write the failing tests** in `tests/reach-people.test.mjs` (open a migrated tmp db):

```js
// 1. upsertCompany("Acme Inc") then "ACME" → same id
// 2. upsertPerson same linkedin_url with different casing → one row, second created=false
// 3. fuzzy: "Jane Doe" @ company Acme vs "Jane  Doe" @ "acme inc" → one row
// 4. addSuppression domain acme.com then upsertPerson with that company domain → null + event suppressed_blocked
// 5. insertEmailAddress twice same (person, email) → one row, second created=false
// 6. insertEmailAddress on a suppressed email → null, email_address count unchanged
```

- [x] **Step 2: Run to verify failure**

```bash
cd fillow-reach && node --disable-warning=ExperimentalWarning --test tests/reach-people.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `../lib/reach/people.mjs`.

- [x] **Step 3: Implement** the signatures in `lib/reach/people.mjs`. Fuzzy name+company: `normalizePersonName` equality AND same `company_id`. Do not pull in a fuzzy library.

- [x] **Step 4: Run tests — all pass.** Then run the full glob; M0 suites stay green.

- [x] **Step 5: Commit**

```bash
git add fillow-reach/lib/reach/people.mjs fillow-reach/tests/reach-people.test.mjs
git commit -m "$(cat <<'EOF'
feat(reach): company/person upsert with R1-3 dedup and suppression gate
EOF
)"
```

---

### Task 2: Connections.csv import + CLI `import`

**Files:**
- Create: `fillow-reach/lib/reach/import-connections.mjs`
- Modify: `fillow-reach/lib/reach/cli.mjs` — append `{ name: "import", summary, run: importCmd }`; remove `import` from `PLANNED`
- Test: `fillow-reach/tests/reach-import-csv.test.mjs`

**Interfaces:**
- Consumes: Task 1 `upsertCompany`, `upsertPerson`, `insertEmailAddress`, `isSuppressed`.
- Produces:
  - `parseConnectionsCsv(csvText) -> Array<{ first, last, full_name, company, title, linkedin_url, email }>` — strip UTF-8 BOM; skip empty rows; header map by lowercased trimmed name. Accept aliases: `first name`/`first`, `last name`/`last`, `company`/`company name`, `position`/`title`, `url`/`linkedin url`/`profile url`, `email address`/`email`. Quoted fields and doubled quotes. Missing columns → empty string, row kept if `full_name` or (`first`+`last`) exists.
  - `importConnectionsCsv(db, csvText, { apply = false, source = "csv_import" }) -> { parsed, imported, skipped, preview }` — `preview` is the parsed array (max 20 in CLI print). When `apply=false`, **no writes**. When `apply=true`, each row: upsert company (if company nonempty), upsertPerson with `source:'csv_import'`, `persona` from title (`/recruit|talent|sourcer/i` → `recruiter`, else `other`), then ensure `connection` row `status='already_connected'`, `accepted_via='csv_import'`, `person.lifecycle='connected'`. Optional email → `insertEmailAddress` source `manual`. `skipped` counts suppressed + missing name. Event `csv_imported` with counts.
  - CLI: `reach import <path>` reads the file; `reach import --yes <path>` sets `apply=true`. Without `--yes`, print `preview` lines and `parsed N, not written (pass --yes)`. Exit 0. Env fixtures `REACH_PROFILE_FILE` / `REACH_DATA_DIR` already honored by `runReachCli`.

- [x] **Step 1: Write the failing tests**

```js
// 1. parse: BOM + headers "Last Name,First Name,Company,Position,URL,Email Address"
//    row: Jane,"Acme, Inc",Engineer,https://www.linkedin.com/in/JaneDoe,jane@acme.com
//    → company includes comma, url normalizes later via upsert
// 2. importConnectionsCsv(apply:false) → imported 0, person table empty
// 3. importConnectionsCsv(apply:true) → person.lifecycle connected, connection.status already_connected
// 4. suppressed email row increments skipped, no person
// 5. CLI via runReachCli(["import", csvPath], fx) → exit 0, DB empty; with --yes → row present
```

- [x] **Step 2:** run `tests/reach-import-csv.test.mjs` — fail on missing module.

- [x] **Step 3: Implement** a small hand-rolled CSV reader (no dependency). `importCmd` in `cli.mjs` reads the last non-flag arg as path (`node:fs` `readFileSync`).

- [x] **Step 4:** tests pass. Existing `tests/reach-cli.test.mjs` still sees `reach import` in usage (it already asserts that string).

- [x] **Step 5: Commit** `feat(reach): Connections.csv import with review-first --yes`

---

### Task 3: Acceptance detection + bounce detection

**Files:**
- Create: `fillow-reach/lib/reach/acceptance.mjs`
- Test: `fillow-reach/tests/reach-acceptance.test.mjs`

**Interfaces:**
- Consumes: `withImap` / `parseMessage` from `lib/reach/imap.mjs` (production path only); Task 1 people helpers.
- Produces:
  - `parseAcceptance(msg) -> { full_name, company } | null` — `msg` is `{ subject, body }` (already decoded). Match subject or body against `/accepted your invitation/i`. Name: first capture of `/([A-Z][A-Za-z.'\-]+(?:\s+[A-Z][A-Za-z.'\-]+)+)\s+has accepted/i` or LinkedIn's `"X has accepted your invitation to connect"` variants. Company: optional `/at\s+(.+?)(?:\.|$)/i` on the same sentence; may be null.
  - `detectAcceptances(db, reachCfg, { fetcher }) -> { checked, accepted, unmatched }` — `fetcher` is required in tests (array of `{ subject, body }`). Production `contacts` command (Task 5) supplies an IMAP fetcher. For each parsed name: find persons whose `normalizePersonName(full_name)` matches and `connection.status IN ('sent','queued','none')`. If `company` present, also require matching `company.name_norm`. Unique match → set `connection.status='accepted'`, `accepted_via='notification_email'`, `accepted_at=datetime('now')`, `person.lifecycle='connected'`, event `invite_accepted`. Already `accepted` → do not double-log. 0 or 2+ matches → event `acceptance_unmatched` with `{ subject }`, no state change.
  - `parseBounce(msg) -> { email, class: "hard"|"soft" } | null` — look for `Status: 5.` / `550` / `5.1.` → hard; `Status: 4.` / `4.2.` → soft. Extract `Final-Recipient` or `Original-Recipient` email.
  - `detectBounces(db, reachCfg, { fetcher }) -> { checked, hard, soft }` — hard: `email_address.verification='invalid'` for that email, `addSuppression({ kind:'email', value, reason:'bounce' })`, related `message.status='bounced'` if a matching out-email exists, event `bounce_hard`. Soft: event `bounce_soft` only.

- [x] **Step 1: Write the failing tests**

```js
// 1. unique "Ada Lovelace has accepted your invitation" + person Ada Lovelace @ X → accepted
// 2. two Ada Lovelaces at different companies, body names no company → unmatched, neither flips
// 3. already accepted → accepted count 0, no second invite_accepted event
// 4. QP body "Ada Lovelace has accepted your invitation" still parses (decode in fixture; pass decoded body)
// 5. hard bounce 550 for ada@x.test → verification invalid + suppression bounce
// 6. soft bounce 4.2.2 → no verification change, event bounce_soft
```

- [x] **Step 2–4:** TDD. IMAP is not called in unit tests — inject `fetcher`.

- [x] **Step 5: Commit** `feat(reach): Gmail acceptance + bounce detectors with injectable fetcher`

---

### Task 4: Hunter provider — cache, quota, run-scoped cooldown

**Files:**
- Create: `fillow-reach/lib/reach/provider-usage.mjs`
- Create: `fillow-reach/lib/reach/provider-hunter.mjs`
- Test: `fillow-reach/tests/reach-hunter.test.mjs`

**Interfaces:**
- Consumes: `insertEmailAddress` (Task 1); `reachCfg.enrichment.{ order, monthlyQuota.hunter, hunterKey }`; `reachCfg.email.requireVerified`.
- Produces:
  - `readProviderUsage(db, provider, month = current YYYY-MM) -> number` — `SELECT calls FROM provider_usage`.
  - `incrementProviderUsage(db, provider, n = 1) -> number` — INSERT or UPDATE monthly row.
  - `enrichEmail(db, reachCfg, personId, { fetchImpl = globalThis.fetch, cooldown } ) -> { email, verification, fromCache } | { skipped: "quota"|"disabled"|"provider_error"|"not_in_order" }`
    - If `"hunter"` not in `enrichment.order` → `not_in_order`.
    - If `monthlyQuota.hunter === 0` or no `hunterKey` → `disabled`.
    - If `readProviderUsage >= monthlyQuota.hunter` → `quota`.
    - If `cooldown.has("hunter")` → `provider_error` (no fetch).
    - Cache key `email_finder:<first>|<last>|<domain>` in `enrichment_cache`. Hit → parse JSON, `insertEmailAddress` with `fromCache: true`, **no** quota increment, **no** fetch.
    - Miss: `GET https://api.hunter.io/v2/email-finder?domain=&first_name=&last_name=&api_key=` via `fetchImpl`. 401/402/429 or network throw → `cooldown.add("hunter")`, `skipped:'provider_error'`, no cache, no quota increment.
    - 200: map Hunter `data.status` / `data.result` (`valid|invalid|accept_all|webmail|disposable|unknown`) onto schema `valid|invalid|accept_all|risky|unknown` (`webmail`/`disposable` → `risky`). Store cache JSON. `incrementProviderUsage`. `insertEmailAddress` source `hunter`. `requireVerified` does **not** rewrite a `risky` row to `valid`.

`cooldown` is a `Set` owned by the agent run (Task 5 creates it). Tests pass a fresh `Set`.

- [x] **Step 1: Write the failing tests**

```js
// 1. monthlyQuota.hunter 0 → skipped disabled, fetchImpl never called
// 2. fetchImpl returns 401 → skipped provider_error, no cache row, usage 0, second call with same Set does not fetch
// 3. 200 finder then second enrichEmail → fromCache true, fetchImpl call count 1
// 4. usage already at quota → skipped quota
// 5. result "risky" with requireVerified true → email_address.verification === "risky"
```

- [x] **Step 2–4:** TDD. Do not add a network library.

- [x] **Step 5: Commit** `feat(reach): Hunter finder with cache, quota, and run-scoped error skip`

---

### Task 5: CLI `contacts` / `suppress` / `forget` + agent + purge

**Files:**
- Create: `fillow-reach/agents/reach-contacts.mjs`
- Modify: `fillow-reach/lib/reach/people.mjs` — add `forgetPerson`, `purgeExpired`
- Modify: `fillow-reach/lib/reach/cli.mjs` — append `contacts`, `suppress`, `forget`; drop them from `PLANNED`
- Test: `fillow-reach/tests/reach-suppression.test.mjs`; add 2–3 cases to `tests/reach-cli.test.mjs` if needed

**Interfaces:**
- Consumes: all prior M1 helpers; `withImap` + `parseMessage` for the production fetcher.
- Produces:
  - `forgetPerson(db, personId) -> { ok: boolean }` — `DELETE FROM person WHERE id=?` (CASCADE). Then `UPDATE event_log SET detail='{"redacted":true}' WHERE entity='person' AND entity_id=?` (and the same for entity `message`/`connection`/`email_address` rows that named that id in detail if easy; minimum is person entity rows). Triggers block DELETE on `event_log` — only UPDATE of `detail` is allowed. Event `person_forgotten` with `{ personId }` **before** delete, then redact that event's detail too if it contains PII — or record the event with `{ personId }` only (no name/email).
  - `purgeExpired(db, retentionDays) -> { purged }` — persons with `lifecycle IN ('closed','suppressed')` and `updated_at < datetime('now', printf('-%d days', retentionDays))` → `forgetPerson`. Test with a `closed` person whose `updated_at` is 181 days ago and `retentionDays=180`.
  - `run(cfg, { emit = () => {}, fetcher, fetchImpl, cooldown = new Set() } = {})` in `agents/reach-contacts.mjs` — `openReachMigratedDb(cfg)`, `detectAcceptances`, `detectBounces`, then for each person `lifecycle IN ('connected','invited')` missing a `valid` email call `enrichEmail` if hunter is in order. `emit("phase.start"|"item.done"|"phase.complete", payload)`. Return `{ accepted, unmatched, hard, soft, enriched, skipped }`. Close db.
  - CLI `contacts` → `run(ctx.cfg, { emit: () => {} })` using production IMAP fetcher when `cfg.mail.configured`, else skip mail with a printed line `mailbox skipped`.
  - CLI `suppress <value>` — kind auto: includes `@` → email; includes `linkedin.` → linkedin_url; else domain. Reason `manual`.
  - CLI `forget <person-id>` — integer id, then `forgetPerson`.

- [x] **Step 1: Write the failing tests** in `tests/reach-suppression.test.mjs`

```js
// 1. PRD §13: suppressed email never enters email_address even if enrichEmail 200s a hunter hit
// 2. suppress linkedin_url of a queued person; detectAcceptances unique match → still unmatched / no accepted flip
//    (isSuppressed on url at match time — skip the flip, event suppressed_blocked)
// 3. forgetPerson removes person + connection; event_log rows remain; person-entity details redacted
// 4. purgeExpired 180 days: updated_at datetime('now','-181 days'), lifecycle closed → person gone;
//    a closed person updated now stays
// 5. runReachCli(["suppress","ada@x.test"], fx) then isSuppressed true
```

Also extend acceptance match (Task 3) if not already: before flipping accepted, `isSuppressed` on that person → skip.

- [x] **Step 2–4:** TDD. Production IMAP fetcher: SEARCH SINCE optional; if IMAP throws, `emit` error and continue to enrichment (one failure never blocks the batch).

- [x] **Step 5: Commit** `feat(reach): contacts agent, suppress/forget/purge, CLI rows on existing dispatcher`

---

## M1 acceptance map (PRD §14 M1)

- Sample export imports → Tasks 1+2.
- Mailbox fixture flips `connection.status` to `accepted` → Task 3.
- Hunter find+verify → Task 4.
- Suppression beats every rule → Tasks 1+5.
- R2-7 retention → Task 5 `purgeExpired`.

## Out of scope (deferred)

- Apollo people-search / Apollo enrich (M2 optional / later).
- DNS MX built-in step (PRD R2-2 lists it; M1 done-when does not require it).
- `bsk` sender (M5).
- Parent `bin/fillow.mjs` registration.
- Recreating `bin/reach.mjs` / `lib/reach/cli.mjs`.
- Paste import of search results (M2). DNS MX if time: add as a micro-task under Task 4 only after Hunter is green.

## Self-review

- Spec: R2-1a/b (IMAP + CSV), R2-2 Hunter+cache, R2-3 store verification, R2-4 quota skip, R2-5 bounces, R2-6 suppression, R2-7 purge. R2-1c bsk check is M5.
- Interfaces: `insertEmailAddress` owned by Task 1 so Task 4 does not invent it.
- Review Focus 1–6 each have a named test above.
