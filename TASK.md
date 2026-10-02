# TASK — M4 R4 Report + dashboard

You are implementing **only M4**. Do not edit parent fillow `job-ui.mjs`. Standalone UI on 127.0.0.1:4181.

**Full plan:** `fillow-reach/docs/plans/2026-10-02-fillow-reach-m4.md`
**Spec:** PRD §5 R4, §6 JSONL, §9 dashboard views, §14 M4

## Done when

- Dashboard: funnel, today’s queue, approvals, people timeline, usage vs caps, health, errors
- Mark-sent sets `sent_via='manual'`
- Daily report builder + optional `--send`
- Append-only `data/reach/events-YYYYMMDD.jsonl`

## Tasks (TDD)

1. dashboard-data + ui + `reach ui` + markInviteSent
2. buildDailyReport + `reach report` / `--send`
3. exportEventsJsonl (append new ids only)

## Test

```bash
cd fillow-reach
node --disable-warning=ExperimentalWarning --test tests/*.mjs
```
