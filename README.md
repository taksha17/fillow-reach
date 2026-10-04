# fillow Reach

**LinkedIn networking assistant for job seekers** — it finds people worth
inviting at the companies you're applying to, tracks who accepted, drafts
polite follow-up messages for your review, and reminds you what to do next.

You stay in control at every step: sending invites is manual, every draft is
fact-checked and needs your approval, and nothing sends until you turn off
practice mode yourself. Everything runs locally — your people data never
leaves this machine.

> **New here?** [`docs/ONBOARDING.md`](docs/ONBOARDING.md) — setup, daily
> workflow, and safety rails in plain language.

## Quick start

Requires **Node.js 22.13+**.

```bash
git clone https://github.com/taksha17/fillow-reach
cd fillow-reach/fillow-reach
npm install
cp .env.example .env          # then fill mailbox / optional keys
node bin/reach.mjs setup      # guided onboarding (~10 min)
node bin/reach.mjs ui         # console at http://127.0.0.1:4181
```

Or run today's full cycle from the terminal (same path the console button uses):

```bash
node bin/reach.mjs run        # prospect → contacts → drafts → JSONL
# schedule it (example: 8:30 local, practice mode still blocks sends)
# 30 8 * * * cd /path/to/fillow-reach/fillow-reach && node bin/reach.mjs run
```

The console's main buttons, in the order you'll use them:

1. **Run today's cycle** — find people, check the inbox, write drafts, archive events.
2. **Find people to invite** — capped list (15/day) of relevant people at target companies.
3. *(You send the invites on LinkedIn, then press "I sent this".)*
4. **Check for acceptances** — reads your inbox for accepted invitations and bounces.
5. **Write draft messages** — one polite, fact-checked draft per accepted connection.
6. **Messages to review** — you approve or discard. Nothing sends itself from the console.

## What it will never do

- Never send anything while practice mode is on (the default).
- Never send an unapproved or fact-unverified draft.
- Never invite the same person twice inside 90 days, anyone you've suppressed,
  or anyone on a company blacklist.
- Never exceed your caps or ignore the Pause switch.
- Never expose your data — the console is loopback-only with a session token.

## Drafts: hosted LLM or local Qwen

Drafts use Groq → NVIDIA NIM → OpenAI when those keys are in `.env`. If none
are set, Reach falls back to a **local Qwen 2.5 1.5B** GGUF (~1GB download,
~1.5GB RAM):

```bash
node bin/reach.mjs llm --pull    # GGUF + CPU llama.cpp
node bin/reach.mjs llm --test    # sanity ping
```

## Commands

```bash
node bin/reach.mjs setup        # first-time wizard
node bin/reach.mjs ui           # console (127.0.0.1:4181)
node bin/reach.mjs run          # full daily cycle
node bin/reach.mjs status       # usage vs caps
node bin/reach.mjs doctor       # config / mailbox / keys
node bin/reach.mjs prospect     # find people to invite
node bin/reach.mjs contacts     # acceptances + enrich
node bin/reach.mjs outreach     # compose drafts (--send after review)
node bin/reach.mjs approve      # review drafts
node bin/reach.mjs report       # daily digest (--send to email it)
node bin/reach.mjs llm          # local Qwen status / --pull / --test
node bin/reach.mjs pause        # stop everything
node bin/reach.mjs resume
```

Caps (not tunable past the defaults): **15 invites/day and 75/7d**, **75
LinkedIn messages/7d**, **15 emails/day**. `dry_run` defaults true.

## Docs

- [`docs/ONBOARDING.md`](docs/ONBOARDING.md) — onboarding + daily workflow
- [`fillow-reach/docs/UI-DESIGN-SYSTEM.md`](fillow-reach/docs/UI-DESIGN-SYSTEM.md) — palette, typography, logo
- [`fillow-reach/fillow Reach — PRD & Data Schema.md`](fillow-reach/fillow%20Reach%20%E2%80%94%20PRD%20%26%20Data%20Schema.md) — product spec
- [`fillow-reach/docs/plans/`](fillow-reach/docs/plans/) — milestone history (M0–M5 shipped)

---

## For developers

This is the outreach product only. Do not rebuild fillow (the job-apply harness).

```
lib/                 vendored fillow helpers so ../../../lib imports resolve
fillow-reach/        the package — all product code lives here
```

```bash
cd fillow-reach
node --disable-warning=ExperimentalWarning --test tests/*.mjs
```

Never recreate `fillow-reach/bin/reach.mjs`. Append CLI rows to
`lib/reach/cli.mjs` only.
