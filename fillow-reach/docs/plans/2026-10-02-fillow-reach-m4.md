# fillow Reach M4 — R4 Report + Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Execute **after M1** (needs people/events). M2/M3 fill the funnel; tests may insert fixture rows. Parent [`lib/job-ui.mjs`](../../../lib/job-ui.mjs) stays **untouched**. Do not recreate the CLI.

**Goal:** R4 (Report + Dashboard): a standalone local Reach UI, a daily report email at `report.time`, and the nightly append-only JSONL export of `event_log`.

**Architecture:** Static HTML renderer + a small `node:http` server in `fillow-reach/lib/reach/ui.mjs` on **127.0.0.1:4181** (fillow console is 4180). Report builder in `lib/reach/report.mjs`. JSONL exporter in `lib/reach/export-jsonl.mjs`. Agent: `agents/reach-report.mjs`. Cloudflare D1 stays out of v1 (PRD R4-5 is aggregate-only and optional).

**Tech Stack:** Node >= 22.13.0 `node:http`, existing `nodemailer`, no frontend framework, no new deps.

**Spec:** PRD §5 R4, §6 JSONL path `data/reach/events-YYYYMMDD.jsonl`, §8 `report.{ time, timezone, attach_resumes }`, §9 dashboard views, §14 M4 row.

## Global Constraints

- Files under `fillow-reach/` only. No edits to parent `job-ui.mjs` / `bin/fillow.mjs`. A later one-line iframe/link is not this milestone.
- Contact PII never leaves the machine except the user's own SMTP report. No D1 names/emails/bodies.
- JSONL is append-only export of `event_log` for that UTC date; gitignored via parent `data/*`.
- Bind UI to `127.0.0.1` only.
- `recordEvent` agent `report`. Tests: never `npm test`.
- Mark-sent from the queue view: POST handler updates `connection.status='sent'`, `sent_via='manual'`, `sent_at`, `person.lifecycle='invited'`. Does not run when paused except it still records the user's manual click (user already sent); skip SMTP. If paused, show a banner but allow mark-sent (the invite already left LinkedIn by hand).

## Review Focus

1. **Empty DB** — UI renders funnel zeros, no throw. Task 1.
2. **Timezone of report.time** — "18:30" in `report.timezone` (`America/Chicago`) decides `report_date`; tests freeze `now`. Task 2.
3. **JSONL does not rewrite history** — second export the same day appends only new event ids. Task 3.
4. **Mark-sent is manual** — button sets `sent_via='manual'`, never `bsk`. Task 1.
5. **Report attaches resumes only when `attach_resumes` and files exist** — missing path skipped, email still sends. Task 2.

## File structure

- Create: `lib/reach/dashboard-data.mjs`, `lib/reach/ui.mjs`, `lib/reach/report.mjs`, `lib/reach/export-jsonl.mjs`, `agents/reach-report.mjs`
- Modify: `cli.mjs` — `report`, `ui`; drop `report` from `PLANNED`
- Tests: `tests/reach-dashboard.test.mjs`, `tests/reach-report-email.test.mjs`, `tests/reach-jsonl.test.mjs`

---

### Task 1: Dashboard data + local UI + mark-sent

**Files:**
- Create: `fillow-reach/lib/reach/dashboard-data.mjs`
- Create: `fillow-reach/lib/reach/ui.mjs`
- Modify: `fillow-reach/lib/reach/cli.mjs` — `ui`
- Test: `fillow-reach/tests/reach-dashboard.test.mjs`

**Interfaces:**
- Consumes: `usageSnapshot`, `healthGuard`, `isPaused`, queue counts from status module pattern.
- Produces:
  - `funnelCounts(db) -> { prospect, invited, connected, messaged, replied, closed, suppressed }` — from `person.lifecycle`.
  - `todayQueue(db) -> rows` — `connection.status='queued'` with person name, title, company, linkedin_url, score.
  - `approvalQueue(db) -> rows` — `message.status='needs_approval'`.
  - `personTimeline(db, personId) -> event_log rows` for that entity_id.
  - `renderDashboardHtml(data) -> string` — sections: Funnel, Today's queue (profile `<a>` + form POST `/mark-sent/:personId`), Approvals, People (link per person), Usage vs caps, Health, Errors (`run.status='failed'` plus `event_log.action` like `provider_error`). Escaped HTML (no raw headline interpolation without escape).
  - `startReachUi(reachCfg, { port = 4181, host = "127.0.0.1" }) -> { server, url }` — `createServer`; GET `/` html; POST `/mark-sent/:id` → `markInviteSent(db, personId)` then 302 `/`.
  - `markInviteSent(db, personId) -> void` — `connection.status='sent'`, `sent_via='manual'`, `sent_at=datetime('now')`, lifecycle `invited`, event `invite_marked_sent`.
  - CLI `ui` prints the URL; `--json` `{ url, port }`. Tests call `renderDashboardHtml` + `markInviteSent` without listen; one smoke can listen on port 0.

- [ ] **Step 1: Failing tests** — empty funnel all 0; html contains "Funnel" and "0"; markInviteSent flips queued → sent_via manual; html escapes `<script>` in a person name fixture.
- [ ] **Step 2–5:** TDD; commit `feat(reach): standalone dashboard on 127.0.0.1:4181 with mark-sent`

---

### Task 2: Daily report email

**Files:**
- Create: `fillow-reach/lib/reach/report.mjs`
- Modify: `cli.mjs` — `report`
- Create: `agents/reach-report.mjs` (compose+optional send)
- Test: `fillow-reach/tests/reach-report-email.test.mjs`

**Interfaces:**
- Produces:
  - `reportDate(now, timeZone) -> YYYY-MM-DD` — calendar date in `reachCfg.report.timezone`.
  - `buildDailyReport(db, reachCfg, { date }) -> { header, rows, attachments }`
    - header: invites/emails vs caps (from `usageSnapshot`), acceptance 14d, reply rate (in messages / out sent, 14d), bounce rate, error count, tomorrow queue size (`status='queued'`).
    - rows: each person touched that date (connection sent/accepted or message sent/replied that day): name, role, company, LinkedIn status, email status+verification, first 120 chars of last out body, reply status, resume sent yes/no.
    - attachments: `resume_asset.path` files sent that day if `report.attachResumes`; skip missing files.
  - `renderReportText(built) -> string` — plain text email.
  - `sendDailyReport(db, reachCfg, { sendMailImpl, now, dryRun })` — insert `report` row `report_date` UNIQUE; if dryRun status `built` only; else SMTP to `reachCfg.mail.user` and `status='sent'`. Event `report_sent`.
  - CLI `report` builds and prints; `report --send` sends unless dry-run.

- [ ] **Step 1: Failing tests** — fixture one LI sent today → one row; header contains `0/15` or used/cap; dryRun does not call sendMailImpl; missing pdf skipped; timezone pin: frozen now in America/Chicago.
- [ ] **Step 2–5:** TDD; commit `feat(reach): daily report email builder and --send`

---

### Task 3: Nightly JSONL export

**Files:**
- Create: `fillow-reach/lib/reach/export-jsonl.mjs`
- Modify: `agents/reach-report.mjs` — call export at end of `run`
- Test: `fillow-reach/tests/reach-jsonl.test.mjs`

**Interfaces:**
- Produces: `exportEventsJsonl(db, reachCfg, { date }) -> { path, written }`
  - Path: `join(reachCfg.paths.eventsDir, `events-${date}.jsonl`)` where `eventsDir` is already `paths.reachDir` from M0.
  - Each event_log row with `ts` on that UTC date → one JSON object `{ id, ts, run_id, agent, entity, entity_id, action, detail }`.
  - If file exists, only append ids greater than the last `id` already in the file (read last line). Never rewrite earlier lines.
  - `run` in the report agent: `buildDailyReport` + `exportEventsJsonl`.

- [ ] **Step 1: Failing tests** — two events → two lines; second call with one new event → file grows by 1 line, first line bytes unchanged.
- [ ] **Step 2–5:** TDD; commit `feat(reach): append-only nightly event_log JSONL export`

---

## M4 acceptance map (PRD §14 M4)

- Report at set time with correct counts → Task 2 (cron wiring: print that `fillow cron` integration waits for parent freeze; v1 is `reach report --send` at `report.time` via the user's existing scheduler or a note in doctor). If adding a Reach cron file under `fillow-reach/scripts/` is a one-pager, include `scripts/cron-report.mjs` that no-ops unless local hour matches — optional, not required for done-when.
- Dashboard views listed in §9 → Task 1.
- JSONL → Task 3.

## Out of scope

- Parent `--ui` Reach tab, Cloudflare aggregates, bsk.

## Self-review

- R4-1 views (standalone), R4-2 time (builder; scheduler deferred with note), R4-3/R4-4 report contents, R4-5 hosted D1 deferred. JSONL from §6 Data lifecycle.
