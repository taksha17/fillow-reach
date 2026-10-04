# fillow Reach — Onboarding & Daily Workflow

fillow Reach helps a job seeker grow and work their LinkedIn network: it
suggests people worth inviting, records what you sent, notices who accepted,
drafts polite follow-up messages for your review, and never sends anything
you didn't approve. **You are always the sender** — the tool plans and
reminds; you press the buttons that matter.

Everything runs on your machine. All data stays in a local SQLite file.

## 0. Install & onboarding (~10 minutes)

```bash
git clone https://github.com/taksha17/fillow-reach
cd fillow-reach/fillow-reach
npm install
node bin/reach.mjs setup     # guided wizard
```

The wizard, in order:

1. **Config block** — appends a `reach:` section to your profile with safe
   defaults (15 invites/day, 75/week).
2. **Two acknowledgements** — you confirm you understand the outreach comes
   from your own accounts and that LinkedIn ToS / email-law compliance in your
   region is your responsibility.
3. **Your mailbox** — Gmail or custom IMAP/SMTP with an app password. The
   wizard tests the login and sends itself one self-test email.
4. **Optional lookup keys** — Hunter / Apollo API keys (skip if you don't
   have them; the free email-pattern step works without keys).
5. **Caps** — you may lower the daily/weekly limits; the wizard never raises
   them past the safe defaults.
6. **Database + health check** — creates the local DB and runs `doctor`.

When it finishes, **practice mode is on** (`dry_run: true`): nothing is ever
sent until you change that yourself in your profile.

Optional: pull a **local Qwen 1.5B** model so drafts still work without Groq
or NVIDIA keys (`~1GB` download, `~1.5GB` RAM):

```bash
node bin/reach.mjs llm --pull
```

## 1. Give it data (three sources)

| Source | How | Why it matters |
|---|---|---|
| **Your job list** | Put a `jobs.tsv` in `data/` (one row per job you're pursuing; `status` ready/applied are kept) | The tool prefers inviting people who work at companies you're applying to. Without this, the invite list stays mostly empty by design. |
| **Your existing network** | LinkedIn → Settings → Get a copy of your data → export, then `node bin/reach.mjs import Connections.csv --yes` | Marks everyone you already know as connected so you never invite them. |
| **New people** | UI → **Add people** tab: paste a LinkedIn search results page → Preview → Save. Or `reach import --paste`. | This is how new prospects enter the list. |
| **Public team pages** | UI → **Add people** tab: paste a company Team/About URL → Fetch team page. | Robots-aware; sites that refuse are skipped cleanly. |
| **Auto-search (optional)** | Get a Google key + Custom Search ID (see **Setup → Google CSE** below), set `GOOGLE_CSE_KEY` + `GOOGLE_CSE_ID` in `.env`, then just press **Find people to invite** — each run searches Google's index for LinkedIn profiles at your target companies | No browser, no LinkedIn session. Brave (`BRAVE_API_KEY`) or Hunter/Apollo keys work the same way when you have them. |

## 2. The daily loop

Start the console:

```bash
node bin/reach.mjs ui        # http://127.0.0.1:4181
# or one command for the whole day:
node bin/reach.mjs run
```

| Step | Button | What happens |
|---|---|---|
| 0 | **Run today's cycle** | Same as `reach run`: find people, check the inbox, write drafts, archive today's events. Nothing is emailed or sent from the console. |
| 1 | **Find people to invite** | Syncs your job list, scores people (persona, job-title overlap, live target company, recency) and fills the **Invites to send** list — max 15/day, 75/week. |
| 2 | **You send the invites** | Open each person's LinkedIn from the list, send the invite yourself, then press **I sent this**. Sending is always manual — the tool never touches your LinkedIn. |
| 3 | **Check for acceptances** | Reads your inbox: who accepted, which emails bounced, and finds verified email addresses. |
| 4 | **Write draft messages** | For accepted connections only, drafts one polite LinkedIn message per person (one per person, ever). Every statement in a draft is fact-checked against your own profile and resume — look for the **facts verified** badge. |
| 5 | **Review** | **Messages to review** tab → Approve the good ones, Discard the rest. Nothing sends from the console. |
| 6 | *(later, when you're ready)* | Approved drafts are only delivered by the separate send step, which respects practice mode, caps, working hours, the PAUSE switch, and health gates. Going live means setting `reach.dry_run: false` in your profile yourself. |
| 7 | **Today's summary** | Builds a digest of where everyone stands. `reach report --send` emails it to you daily. |

### The follow-up email (automatic, still review-first)

If a LinkedIn message was actually sent and the person has a **verified**
email address, the first email draft appears 2 days later, and one follow-up
7 days after that. Then it stops — no third touch. If they reply at any
point, everything stops for them.

## 3. Safety rails (always on)

- **Practice mode** — nothing sends until you flip it in your profile. No
  button anywhere can override it.
- **Pause everything** — one-click stop; checked before every send.
- **Never contact** — add an email, LinkedIn page, or whole company domain;
  it beats every other rule.
- **Delete person** — erases someone completely (confirm-gated).
- **Health gates** — if less than 25% of people accept over 2 weeks, the
  invite target halves; if more than 3% of emails bounce, email sending
  pauses itself.
- **No re-invites** within 90 days; company blacklist honored.
- **Local only** — the console binds to 127.0.0.1 with a per-session token.

## Command reference (plain words)

```bash
node bin/reach.mjs setup        # first-time wizard
node bin/reach.mjs ui           # open the console (127.0.0.1:4181)
node bin/reach.mjs run          # full daily cycle (prospect → contacts → drafts)
node bin/reach.mjs status       # quick text summary of everything
node bin/reach.mjs doctor       # is anything misconfigured?
node bin/reach.mjs import ...   # Connections.csv or --paste text
node bin/reach.mjs prospect     # same as "Find people to invite"
node bin/reach.mjs contacts     # same as "Check for acceptances"
node bin/reach.mjs outreach     # same as "Write draft messages"
node bin/reach.mjs approve      # list drafts needing review
node bin/reach.mjs report       # build the daily digest
node bin/reach.mjs llm          # local Qwen status / --pull / --test
node bin/reach.mjs pause        # stop everything
node bin/reach.mjs resume       # ...then start again
node bin/reach.mjs suppress X   # never contact this email/URL/domain
node bin/reach.mjs forget N     # erase person N and their data
```

## Known limits (honest list)

- Sending LinkedIn invites is manual by design; an optional logged-in-browser
  auto-sender exists but is off by default.
- Public company team pages: **Add people** → paste a Team/About URL → Fetch
  team page. Sites that refuse robots are skipped cleanly.
- A recruiter at a target company with no job-title overlap scores 65 —
  below the 70 bar and stays unqueued. That's the scoring gate working, not a
  bug; queue people whose titles actually relate to your target roles.

## Setup: Google CSE (free auto-search keys)

1. **Google Cloud** (https://console.cloud.google.com) → create or pick a project.
2. **APIs & Services → Library** → enable **Custom Search API**.
3. **APIs & Services → Credentials** → **Create credentials → API key** → copy it.
   (Optionally restrict it to the Custom Search API for safety.)
4. **Programmable Search Engine** (https://programmablesearchengine.google.com) →
   **Add** → name it anything → "Search the entire web" ON → Create → open the
   engine → copy the **Search engine ID (cx)**.
5. Put both in `fillow-reach/.env`:

```
GOOGLE_CSE_KEY=<your API key>
GOOGLE_CSE_ID=<your cx id>
```

6. Restart the console, or schedule the unattended job (no browser, no bsk):

```
# crontab — 8:30 local; dry_run still blocks sends
30 8 * * * cd /path/to/fillow-reach/fillow-reach && node bin/reach.mjs run
```

`reach run` searches Google's public index (`site:linkedin.com/in "recruiter" "company"`)
for up to 15 companies per day (the invite cap), stores public profile URLs/titles,
queues matches, drafts, and writes JSONL. It never opens LinkedIn.

**Fetch from my LinkedIn** in the console is the interactive path (bsk, your
logged-in browser). That cannot run from cron.

The tool never touches LinkedIn or your account on the cron path; Google answers
the query from its public index.
