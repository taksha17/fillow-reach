# fillow Reach

Standalone GitHub repo for **fillow Reach** (recruiter outreach). M0 is on `main`. Each remaining agent is a **separate PR** so different AIs can implement in parallel.

**Do not rebuild fillow** (job apply). This is not Agents 1–4.

| Branch / PR | Agent | Implement |
| --- | --- | --- |
| `feat/m1-r2-contacts` | R2 Contacts | CSV import, Gmail acceptances, Hunter, suppress/forget |
| `feat/m2-r1-prospect` | R1 Prospect | jobs.tsv targets, paste import, public pages, score + queue |
| `feat/m3-r3-outreach` | R3 Outreach | drafts, grounding, review approval, SMTP |
| `feat/m4-r4-report` | R4 Report | standalone dashboard, daily email, JSONL |
| `feat/m5-optional-bsk` | optional | bsk sender, sample/auto, health guard at send |

Start from `TASK.md` on that branch (and `fillow-reach/docs/plans/`). Spec: `fillow-reach/fillow Reach — PRD & Data Schema.md`.

## Layout

```
lib/                 vendored fillow helpers so ../../../lib imports resolve
fillow-reach/        the package — put all new code here
```

```bash
cd fillow-reach
node --disable-warning=ExperimentalWarning --test tests/*.mjs
```

Never `npm test`. Never recreate `fillow-reach/bin/reach.mjs`. Append CLI rows only. Ignore `.qwen/`.
