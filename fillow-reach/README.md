# fillow Reach (package)

Product README lives at the repo root: [`../README.md`](../README.md).
Onboarding: [`../docs/ONBOARDING.md`](../docs/ONBOARDING.md).
Spec: [`fillow Reach — PRD & Data Schema.md`](./fillow%20Reach%20%E2%80%94%20PRD%20%26%20Data%20Schema.md).

## Run

Node >= 22.13.0. From this directory:

```bash
npm install
node bin/reach.mjs setup
node bin/reach.mjs ui          # also: npm start
node bin/reach.mjs run         # also: npm run run
```

```bash
node --disable-warning=ExperimentalWarning --test tests/*.mjs
```

Do not use `npm test` on the original fillow machine (the npm wrapper hangs);
the `test` script itself is the same `node --test` invocation CI uses.

## Rules

- Append CLI rows to `lib/reach/cli.mjs` `commands`. Do not recreate `bin/reach.mjs`.
- Do not invent tables, cap numbers, or `reach:` yaml keys — the PRD is the spec.
- Caps: invites 15/day and 75/7d, LinkedIn messages 75/7d, emails 15/day.
- `reach.dry_run` defaults true; `REACH_DRY_RUN=true` forces dry. `data/reach/PAUSE` stops sends.
