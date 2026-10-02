# fillow Reach

Recruiter / hiring-manager outreach (LinkedIn queue + email). A second agent family next to fillow, **not** a rebuild of fillow's job-application pipeline (discover → evaluate → apply → track).

**Spec:** [`fillow Reach — PRD & Data Schema.md`](./fillow%20Reach%20%E2%80%94%20PRD%20%26%20Data%20Schema.md)

**Plans (read first):** [`docs/plans/README.md`](./docs/plans/README.md)

M0 (schema, caps, kill switch, `setup` / `doctor` / `status`) is shipped. M1–M5 are the remaining agent work, each on its own GitHub PR.

## Commands

From this directory:

```bash
node --disable-warning=ExperimentalWarning --test tests/*.mjs   # never npm test (hangs on this machine)
node bin/reach.mjs status
node bin/reach.mjs doctor --no-mail
```

Node >= 22.13.0. Secrets in `.env` only (see `.env.example`). `reach.dry_run` defaults true.

## Hard rules

- Append CLI rows to `lib/reach/cli.mjs` `commands`. Do not recreate `bin/reach.mjs`.
- Do not write fillow Agents 1–4, Greenhouse scrapers, or a fillow README here.
- Caps: invites 15/day and 75/7d, LinkedIn messages 75/7d, emails 15/day.
