# fillow Reach

**LinkedIn networking assistant for job seekers** — it finds people worth
inviting at the companies you're applying to, tracks who accepted, drafts
polite follow-up messages for your review, and reminds you what to do next.

You stay in control at every step: sending invites is manual, every draft is
fact-checked and needs your approval, and nothing sends at all until you turn
off practice mode yourself. Everything runs locally — your data never leaves
your machine (except the LLM call that writes your drafts, which uses your own
API key).

> **New here?** Read [`docs/ONBOARDING.md`](docs/ONBOARDING.md) — the full
> setup wizard, daily workflow, and safety rails in plain language.

## Quick start

```bash
git clone https://github.com/taksha17/fillow-reach
cd fillow-reach/fillow-reach
npm install
node bin/reach.mjs setup   # guided onboarding (~10 min)
node bin/reach.mjs ui      # console at http://127.0.0.1:4181
```

The console's main buttons, in the order you'll use them:

1. **Find people to invite** — builds a capped list (15/day) of relevant people
   at your target companies.
2. *(You send the invites on LinkedIn, then press "I sent this".)*
3. **Check for acceptances** — reads your inbox for accepted invitations and
   bounces.
4. **Write draft messages** — one polite, fact-checked draft per accepted
   connection.
5. **Messages to review** — you approve or discard. Nothing sends itself.

## What it will never do

- Never send anything while practice mode is on (the default).
- Never send an unapproved or fact-unverified draft.
- Never invite the same person twice inside 90 days, anyone you've suppressed,
  or anyone on a company blacklist.
- Never exceed your caps or ignore the Pause switch.
- Never expose your data — the console is loopback-only with a session token.

## Docs

- [`docs/ONBOARDING.md`](docs/ONBOARDING.md) — complete onboarding + daily workflow
- `fillow-reach/fillow Reach — PRD & Data Schema.md` — product spec & data model
- `fillow-reach/docs/plans/` — per-milestone implementation plans

---

## For developers

**Do not rebuild fillow** (the job-apply harness). This is the outreach
product only.

```
lib/                 vendored fillow helpers so ../../../lib imports resolve
fillow-reach/        the package — all product code lives here
```

```bash
cd fillow-reach
node --disable-warning=ExperimentalWarning --test tests/*.mjs
```

Never `npm test` (hangs on this machine). Never recreate
`fillow-reach/bin/reach.mjs`. Append CLI rows to `lib/reach/cli.mjs` only.
Plan docs for each milestone live in `fillow-reach/docs/plans/`.
