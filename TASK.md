# TASK — production-ready daily cycle + local Qwen

M0–M5 are on `main`. This branch finishes the shipped product:

- PRD §9 `reach run` (prospect → contacts → outreach compose → JSONL → report)
- Console **Run today's cycle** (compose only; no send from the UI)
- Optional local Qwen 2.5 1.5B (`reach llm --pull`) folded from PR #6
- Install/docs: README, onboarding, `package.json` 1.0.0, CI

**Spec:** PRD §9 CLI `run`, R1–R4 already on main.
**Do not merge to `main` until the live trial is done.**

## Done when

- `reach run --json` exits 0 on an empty DB; `--send` is ignored while `dry_run`
- UI button `data-run=daily` calls the same runner
- Hosted LLM first, then local GGUF; doctor rows `local llm` / `local runtime`
- Full `tests/*.mjs` green

## Test

```bash
cd fillow-reach
node --disable-warning=ExperimentalWarning --test tests/*.mjs
```

Never `npm test` on the fillow machine. Fake identities only.
