# fillow Reach M5 — Optional bsk, approval ramp, health guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Execute **after M3**. Everything here is **flagged / opt-in**. Default install behavior must stay `linkedin.send_mode: queue` and `approval_mode: review`. Do not recreate the CLI. Do not add anti-bot evasion or fingerprint spoofing (PRD non-goals).

**Goal:** Optional M5: send blank LinkedIn invites/messages through the user's logged-in Chromium (`bsk`) behind an explicit acknowledgement; promote `review → sample → auto` only after N clean approvals; apply the M0 `healthGuard` rates at send time (halve daily caps / pause email).

**Architecture:** Thin adapters over existing M3 `sendApproved` and M2 queue. bsk via parent `../../../lib/bsk.mjs` or the fillow-browser skill CLI — **read-only import**; if bsk is missing, doctor warns and send_mode `bsk` refuses with a clear error (queue still works). Auto-PAUSE on warning/captcha/restriction copy in page text.

**Tech Stack:** Node >= 22.13.0, existing kill switch, existing `assertSendAllowed`. No new stealth libraries.

**Spec:** PRD §5 R1-6/R1-7, R3-7, §7 health guard + kill switch, §9a bsk acknowledgement, §14 M5 row, §15 decision 3 (bsk deferred to M5 behind a flag).

## Global Constraints

- Default cfg unchanged: `sendMode: "queue"`, `approvalMode: "review"`.
- bsk path requires a stored acknowledgement file `data/reach/BSK_ACK` written only by `reach setup --ack-bsk` after an explicit yes. Without it, `send_mode: bsk` throws `/acknowledgement/`.
- Any detected LinkedIn warning, captcha, restriction, or unexpected URL → `pause(reachCfg, note)` and abort the rest of the batch. Event `linkedin_warning`.
- Invites stay **blank** (`inviteNote: false`). Do not send invite notes via bsk.
- Health guard: if `halfTargets`, treat daily invite and email caps as `floor(cap/2)` at `assertSendAllowed` time (wrap, do not fork cap math). If `emailPaused` (bounce > 5%), email sends throw `/health/` and stay queued.
- `recordEvent` agent as the caller (`outreach` / `prospect` / `cli`). Tests: never `npm test`.
- No scraping, no UA spoofing, no captcha-solving.

## Review Focus

1. **queue mode still default** — with `sendMode: "queue"`, bsk client never called. Task 1.
2. **Missing BSK_ACK** — bsk send throws, no pause file. Task 1.
3. **Simulated warning page** — fixture `pageText` containing `we restricted your account` → PAUSE created. Task 1.
4. **sample mode** — first N (default 5) still need approval; N+1 auto-approved only if last N `approved_by='user'` and none had edits (store `approved_by` + optional `edited` flag). Task 2.
5. **grounding demotion** — any `grounding_ok=0` resets mode tracking to review (config write is **not** automatic — set an in-db `run.stats` / event `approval_demoted`; do not silently rewrite profile.yaml). Task 2.
6. **halfTargets** — 1/5 accepts in 14d → next invite checkCap uses 7 not 15 (or fixture caps 4 → 2). Task 3.

## File structure

- Create: `lib/reach/bsk-send.mjs`, `lib/reach/approval-ramp.mjs`, `lib/reach/health-apply.mjs`
- Modify: `lib/reach/send.mjs` (M3) — call health wrap; optional bsk for linkedin channel
- Modify: `lib/reach/doctor.mjs` — bsk ack + bsk binary rows (warn, not fail)
- Tests: `tests/reach-bsk-send.test.mjs`, `tests/reach-approval-ramp.test.mjs`, `tests/reach-health-apply.test.mjs`

---

### Task 1: bsk sender behind flag + auto-pause

**Files:**
- Create: `fillow-reach/lib/reach/bsk-send.mjs`
- Modify: `fillow-reach/lib/reach/send.mjs` — LinkedIn branch
- Test: `fillow-reach/tests/reach-bsk-send.test.mjs`

**Interfaces:**
- Produces:
  - `hasBskAck(reachCfg) -> boolean` — `existsSync(join(reachCfg.paths.reachDir, "BSK_ACK"))`.
  - `writeBskAck(reachCfg)` — atomic write ISO timestamp + "user accepted LinkedIn ToS risk".
  - `detectLinkedinHazard(pageText, pageUrl) -> string | null` — return reason if `/captcha|unusual activity|restricted|checkpoint|sorry, we|verify you.re human/i` or host not `linkedin.com`.
  - `sendLinkedinViaBsk({ url, kind: "invite"|"message", body, bskImpl }) -> { ok, pageText, pageUrl }` — `bskImpl` injectable; production wraps `bsk` CLI. Invites: navigate to profile, click Connect, **no note**. Messages: InMail/thread, paste `body`. After action, read page text; if hazard → throw after caller pauses.
  - Send integration: if `channel==='linkedin' && sendMode==='bsk'`: require ack; call bsk; on hazard `pause()` and rethrow. If `sendMode==='queue'`, keep M3 mark-sent behavior.

- [x] **Step 1: Failing tests** — queue mode never calls `bskImpl`; bsk without ack throws `/acknowledgement/`; bskImpl returns warning copy → `isPaused` true; happy path invite `bskImpl` called with `kind: "invite"` and empty body.
- [x] **Step 2–5:** TDD; commit `feat(reach): optional bsk LinkedIn send with ack + auto-PAUSE on warnings`

---

### Task 2: `sample` / `auto` approval ramp

**Files:**
- Create: `fillow-reach/lib/reach/approval-ramp.mjs`
- Modify: M3 `approveDraft` / outreach compose to consult ramp
- Test: `fillow-reach/tests/reach-approval-ramp.test.mjs`

**Interfaces:**
- Produces:
  - `N_SAMPLE = 5`, `N_AUTO = 10` (consecutive user approvals with no `edited`).
  - `consecutiveCleanApprovals(db) -> number` — trailing `approved_by='user'` messages without `detail.edited` / a column; stop count at any `grounding_ok=0` or missing approved_by.
  - `autoApproveAllowed(reachCfg, db) -> boolean` — `approvalMode==='auto'` && consecutive ≥ N_AUTO && last grounding_ok 1; or `sample` && consecutive ≥ N_SAMPLE (then auto the rest with random 10% still left `needs_approval` for audit — use `Math.random` via `rngImpl` for tests).
  - Compose path: if `autoApproveAllowed`, set `status='approved'`, `approved_by='auto'`. Event `draft_auto_approved`.
  - If a new draft has `grounding_ok=0`: event `approval_demoted` (do not rewrite yaml).

- [x] **Step 1: Failing tests** — review mode never auto; 5 clean user approvals + sample → 6th auto (rngImpl always 0.9 so not audit); grounding_ok 0 → autoApproveAllowed false even in auto; rngImpl 0.05 in sample → still needs_approval (audit).
- [x] **Step 2–5:** TDD; commit `feat(reach): sample/auto approval ramp with grounding demotion event`

---

### Task 3: Apply health guard at send time

**Files:**
- Create: `fillow-reach/lib/reach/health-apply.mjs`
- Modify: `lib/reach/caps.mjs` or `send.mjs` — before `assertSendAllowed`
- Test: `fillow-reach/tests/reach-health-apply.test.mjs`

**Interfaces:**
- Produces:
  - `effectiveLimits(db, reachCfg) -> limits` — copy of `reachCfg.limits`; if `healthGuard.halfTargets`, `invitesPerDay` and `emailsPerDay` become `Math.max(1, Math.floor(n/2))`. Week caps unchanged.
  - `assertSendAllowedHealthy({ db, reachCfg, action, count })` — if action `email` and `healthGuard.emailPaused`, throw `/health/ email paused`. Else `assertSendAllowed` with `{ ...reachCfg, limits: effectiveLimits(...) }`.
  - M3 `sendApproved` uses `assertSendAllowedHealthy` instead of raw `assertSendAllowed`.

- [x] **Step 1: Failing tests** — 1 accepted / 5 sent in 14d → halfTargets, invitesPerDay 4 becomes 2, third invite send throws cap; bounce rate > 5% → email throw `/health/` with invites still allowed.
- [x] **Step 2–5:** TDD; commit `feat(reach): apply 14d health guard to send-time caps`

---

### Task 4: Doctor rows for bsk + M5 flags

**Files:**
- Modify: `fillow-reach/lib/reach/doctor.mjs`
- Test: extend `tests/reach-doctor.test.mjs`

**Interfaces:**
- Add warn rows: `send_mode=bsk` without BSK_ACK; bsk binary missing (`which bsk` / `bsk status` injectable); `approval_mode` sample/auto noted. Fail rows never for optional bsk.

- [x] **Step 1–5:** TDD; commit `feat(reach): doctor warns on bsk ack/binary and non-review approval`

---

## M5 acceptance map (PRD §14 M5)

- Auto-pause on simulated warning page → Task 1.
- sample/auto → Task 2.
- Health guard tuning applied → Task 3.

## Out of scope

- Changing PRD default caps, stealth, parent fillow UI tab, Apollo, OAuth mail.

## Self-review

- R1-6 bsk opt-in, R1-7 auto-pause, R3-7 sample/auto, §7 halfTargets + bounce pause, §9a separate bsk acknowledgement. Queue remains the safe default.
