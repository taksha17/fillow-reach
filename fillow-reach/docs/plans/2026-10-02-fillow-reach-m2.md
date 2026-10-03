# fillow Reach M2 — R1 Prospect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Execute **after M1**. Do not recreate the CLI. Do not scrape LinkedIn. Do not enable `linkedin.send_mode: bsk` (M5).

**Goal:** R1 (Prospect): turn live fillow jobs + paste/CSV/public-page sources into a daily invite queue of 10–15 scored people with stored reasons, in `queue` sender mode only.

**Architecture:** Read parent `jobs.tsv` via `readJobs` (import from `../../../lib/jobs-tsv.mjs`, read-only). Upsert `company` / `target_role` / `person` / `person_target` / `connection(status='queued')`. CLI `prospect` and `import --paste` append to existing `commands`. Agent: `fillow-reach/agents/reach-prospect.mjs`.

**Tech Stack:** Node >= 22.13.0 ESM, `node:sqlite`, `node:test`, `globalThis.fetch` for public pages. No new dependencies. Optional Apollo/Hunter people-search only when key **and** `monthly_quota > 0`.

**Spec:** PRD §5 R1 (R1-1…R1-10), §1 volume caps, §7 rolling windows, §8 `min_relevance` / `personas` / `limits.invites_per_day`, §9 `prospect` / `import --paste`, §14 M2 row. Discovery sources: paste, Connections.csv (already M1), public pages, optional own-key Apollo/Hunter. **No LinkedIn scraping.**

## Global Constraints

- Files only under `fillow-reach/`. Parent fillow modules are import-read-only.
- Caps: queue at most `limits.invitesPerDay` (15) **and** remaining `invitesPer7d` (75) headroom. Over cap: extra candidates stay unqueued (no `connection` row), never fail the run.
- Skip (R1-4): blacklisted companies (`company.blacklisted` or parent `data/blacklist.md` names), `isSuppressed`, existing `connection.status` in `already_connected|accepted|sent`, anyone with `connection.sent_at` within 90 days.
- Queue only `relevance_score >= reachCfg.minRelevance` (default 70).
- `personas` from config; default `[recruiter, hiring_manager, senior_ic]`. Executive only when company looks small (≤ 50 employees **if** a source provides it; otherwise skip `executive` unless paste/manual sets it).
- `linkedin.send_mode` stays `queue`. No bsk. Dashboard "mark sent" is M4; M2 stores `connection.status='queued'` only.
- `recordEvent` agent `prospect`. Tests: `node --disable-warning=ExperimentalWarning --test tests/<file>.mjs`. Never `npm test`.
- Fake identities only.

## Review Focus

1. **jobs.tsv missing or empty** — `syncTargets` returns `{ targets: 0 }` and prospect still runs paste-only sources; no throw. Task 1 test.
2. **Invite 90-day skip** — person invited 89 days ago is skipped; 91 days ago may queue. Task 4.
3. **Daily cap vs 7d cap** — 14 queued today blocked by day cap even if week has room; 74 sent this week + 2 scored today → only 1 queued. Task 4 uses `datetime('now')` inserts like M0 cap tests.
4. **Paste without --yes** — zero writes (same contract as M1 CSV). Task 2.
5. **Public page robots / 403** — skip that URL, continue the batch, event `public_page_skipped`. Task 3.
6. **Provider error** — Apollo/Hunter people-search 429 → skip provider for the run, still return scored paste/csv people. Task 5.

## File structure

- Create: `lib/reach/targets.mjs`, `lib/reach/import-paste.mjs`, `lib/reach/public-pages.mjs`, `lib/reach/score.mjs`, `lib/reach/queue.mjs`, `lib/reach/provider-people-search.mjs`, `agents/reach-prospect.mjs`
- Modify: `lib/reach/cli.mjs` — `prospect`; extend `import` to accept `--paste`
- Tests: `tests/reach-targets.test.mjs`, `tests/reach-import-paste.test.mjs`, `tests/reach-public-pages.test.mjs`, `tests/reach-score-queue.test.mjs`, `tests/reach-prospect.test.mjs`

---

### Task 1: Sync `target_role` from jobs.tsv

**Files:**
- Create: `fillow-reach/lib/reach/targets.mjs`
- Test: `fillow-reach/tests/reach-targets.test.mjs`

**Interfaces:**
- Consumes: `readJobs(path)` from `../../../lib/jobs-tsv.mjs`; Task M1 `upsertCompany`.
- Produces: `syncTargets(db, reachCfg, { jobs } = {}) -> { upserted, skipped }`
  - `job_ref` = `${source}:${external_id}` (PRD §6 `target_role.job_ref`).
  - Include jobs whose `status` is `ready` or `applied` (case-insensitive). Missing status treated as include (uncertain-kept).
  - `upsertCompany` from `job.company`; `target_role` UNIQUE on `job_ref` — INSERT or UPDATE title/url/status.
  - Default jobs path: `join(reachCfg.paths.dataDir, "jobs.tsv")`. Tests pass `jobs` array and skip the file.

- [x] **Step 1: Failing tests**

```js
// 1. two jobs ready/applied → two target_role rows, companies deduped if same name
// 2. status "closed" skipped
// 3. jobs: [] → upserted 0, no throw
// 4. second sync same job_ref updates title, row count unchanged
```

- [x] **Step 2:** run test — missing module.
- [x] **Step 3: Implement** `syncTargets` in `lib/reach/targets.mjs`.
- [x] **Step 4:** pass.
- [x] **Step 5: Commit** `feat(reach): sync target_role rows from jobs.tsv ready/applied`

---

### Task 2: Paste import (`reach import --paste`)

**Files:**
- Create: `fillow-reach/lib/reach/import-paste.mjs`
- Modify: `fillow-reach/lib/reach/cli.mjs` — `importCmd`: if `--paste`, read stdin (or `--file`) as text; keep CSV path behavior from M1
- Test: `fillow-reach/tests/reach-import-paste.test.mjs`

**Interfaces:**
- Consumes: M1 `upsertCompany`, `upsertPerson`.
- Produces: `parsePaste(text) -> Array<{ full_name, title, company, linkedin_url }>`
  - Lines or blocks matching `Name — Title at Company` / `Name\nTitle at Company\nlinkedin.com/in/...`.
  - URL regex `linkedin.com/in/[A-Za-z0-9_-]+`. Skip lines with no name.
  - `importPaste(db, text, { apply = false, source = "paste_import" }) -> { parsed, imported, skipped, preview }` — same review-first as CSV. `persona` from title (recruiter / hiring manager / engineer|scientist|designer → senior_ic / else other). Does **not** set `connection` (these are prospects, not already-connected). Event `paste_imported`.

- [x] **Step 1: Failing tests** — three-line paste with URL; `apply:false` writes 0; `apply:true` one person `source='paste_import'`; CLI `--paste` without `--yes` writes 0 (inject text via function, not real stdin, in the unit test; CLI smoke can pass a temp file with `--paste --file`).
- [x] **Step 2–5:** TDD; commit `feat(reach): paste import of search/company-page text (review-first)`

---

### Task 3: Public company pages (no login)

**Files:**
- Create: `fillow-reach/lib/reach/public-pages.mjs`
- Test: `fillow-reach/tests/reach-public-pages.test.mjs`

**Interfaces:**
- Consumes: M1 upserts; `fetchImpl` injectable.
- Produces:
  - `robotsAllows(robotsTxt, path) -> boolean` — if fetch of `origin/robots.txt` fails, treat as allow. If `User-agent: *` `Disallow: /` covers the path, deny.
  - `extractPeople(html, { company }) -> Array<{ full_name, title, linkedin_url }>` — names from obvious team-page patterns (`<h2>`/`itemprop`/`linkedin.com/in/` anchors). Best-effort; empty array is ok.
  - `importPublicPage(db, url, { fetchImpl, apply = true }) -> { imported, skipped, reason }` — if robots deny or HTTP 403/401/404 → `{ skipped: 1, reason: "blocked"|"not_found" }`, event `public_page_skipped`. No fingerprint spoofing. `source='public_page'`.

- [x] **Step 1: Failing tests** — robots Disallow skip (no upsert); 200 HTML with one `/in/` link + name → person; 403 → skipped, no throw.
- [x] **Step 2–5:** TDD; commit `feat(reach): public team-page import honoring robots.txt`

---

### Task 4: Relevance score + daily queue

**Files:**
- Create: `fillow-reach/lib/reach/score.mjs`
- Create: `fillow-reach/lib/reach/queue.mjs`
- Test: `fillow-reach/tests/reach-score-queue.test.mjs`

**Interfaces:**
- Consumes: `usageSnapshot` / `checkCap` from M0; M1 `isSuppressed`; `reachCfg.minRelevance`, `reachCfg.personas`, `reachCfg.limits`.
- Produces:
  - `scorePerson({ title, persona, companyIsTarget, recencyDays }) -> { score, reasons: string[] }` — integer 0–100. Pins:
    - persona in configured list: +30, reason `persona:<name>`
    - title keyword overlap with target role title tokens: +25, `title-match`
    - `companyIsTarget`: +25, `live-target`
    - `recencyDays != null && recencyDays <= 30`: +10, `recent`
    - `senior_ic` or `hiring_manager`: +10, `seniority`
    - clamp 0–100. Reasons JSON array stored on `person.relevance_reasons`.
  - `queueDaily(db, reachCfg, { now } = {}) -> { considered, queued, skipped }` — consider `person` rows with `lifecycle='prospect'`, no blocking connection, score ≥ min, persona in list. Sort by score desc, then id. For each, `checkCap({ db, reachCfg, action: "invite" })`; if `!ok`, stop (rest stay prospect, not failed). Insert/update `connection` `status='queued'`, `queued_at`, `person_target` if a `target_role` exists for that company. Event `invite_queued`. Apply R1-4 skips first.

- [x] **Step 1: Failing tests**

```js
// 1. recruiter + live target + title match → score >= 70 and reasons include those keys
// 2. score 40 below minRelevance 70 → queueDaily queued 0
// 3. already_connected skipped
// 4. sent_at datetime('now','-89 days') skipped; -91 days may queue
// 5. 15 already sent today (connection.sent_at now) → queued 0 (day cap) even with 20 scored prospects
// 6. suppressed linkedin_url skipped
```

- [x] **Step 2–5:** TDD; commit `feat(reach): relevance scoring and capped invite queue`

---

### Task 5: Prospect agent + optional people-search

**Files:**
- Create: `fillow-reach/lib/reach/provider-people-search.mjs`
- Create: `fillow-reach/agents/reach-prospect.mjs`
- Modify: `fillow-reach/lib/reach/cli.mjs` — command `prospect`
- Test: `fillow-reach/tests/reach-prospect.test.mjs`

**Interfaces:**
- Produces:
  - `searchPeople(reachCfg, { company, fetchImpl, cooldown }) -> Array<personDraft> | { skipped }` — if apollo quota 0 and hunter quota 0, return []. 4xx/5xx → cooldown skip. Map drafts to `upsertPerson` `source` `apollo` or `hunter`.
  - `run(cfg, { emit, jobs, fetchImpl, cooldown } = {})` — `syncTargets` → optional search per target company → `queueDaily`. Return `{ targets, queued, skipped }`.
  - CLI `prospect` loads cfg, runs `run`, prints queued count.

- [x] **Step 1: Failing tests** — `run` with two in-memory jobs + two paste-level persons already in db → queued ≥ 1; fetchImpl 429 → still queues local people; CLI `prospect` exit 0 on fixture cfg.
- [x] **Step 2–5:** TDD; commit `feat(reach): prospect agent + optional own-key people search`

---

## M2 acceptance map (PRD §14 M2)

- 10–15 ranked people per day with stored reasons → Task 4 (cap 15, reasons JSON).
- Paste + Connections.csv + public pages → Task 2, M1 CSV, Task 3.
- Queue is `connection.status='queued'` (manual mark-sent UI is M4).

## Out of scope

- bsk invites (M5), dashboard mark-sent (M4), LinkedIn scraping, parent fillow registration.

## Self-review

- R1-1 personas, R1-2 score+reasons, R1-3 dedup (M1 upsert), R1-4 skips, R1-5 caps, R1-6 queue mode, R1-8 paste, R1-9 public pages, R1-10 own-key skip-on-error. R1-7 is bsk (M5).
