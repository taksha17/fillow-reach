# Agent notes — fillow Reach

This folder is **Reach** (outreach), not fillow (job apply).

1. Read `docs/plans/README.md`, then the milestone plan for your PR (`TASK.md` on feature branches).
2. Spec: `fillow Reach — PRD & Data Schema.md`. Do not invent schema, caps, or `reach:` keys.
3. Append CLI commands to `lib/reach/cli.mjs` `commands`. Do not create a second CLI.
4. Tests: `cd fillow-reach && node --disable-warning=ExperimentalWarning --test tests/*.mjs`
5. Ignore `.qwen/`. Do not modify parent fillow except gitignored user-layer files.
