# TASK — M2 R1 Prospect

You are implementing **only M2**. Depends on M1 people upsert if that has landed; otherwise use the people helpers described in the M1 plan or wait for M1 to merge.

**Full plan:** `fillow-reach/docs/plans/2026-10-02-fillow-reach-m2.md`
**Spec:** PRD §5 R1, §14 M2
**Index:** `fillow-reach/docs/plans/README.md`

## Done when

- 10–15 ranked people per day with stored `relevance_reasons`
- Paste import + public pages + (M1) Connections.csv
- Queue is `connection.status='queued'` (mark-sent UI is M4)

## Tasks (TDD)

1. `lib/reach/targets.mjs` — sync `target_role` from jobs.tsv ready/applied
2. Paste import `reach import --paste` (review-first `--yes`)
3. Public pages + robots.txt, skip 403
4. Score 0–100 + `queueDaily` with invite caps 15/day and 75/7d
5. `agents/reach-prospect.mjs` + CLI `prospect`

No LinkedIn scraping. `send_mode: bsk` is M5.

## Test

```bash
cd fillow-reach
node --disable-warning=ExperimentalWarning --test tests/*.mjs
```
