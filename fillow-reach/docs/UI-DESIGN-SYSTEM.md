# fillow Reach — UI design system

fillow Reach shares its visual language with fillow (the job-apply harness).
This document is the reference for anyone changing the console UI: what the
tokens are, which components exist, and the logo rules. The implementation
lives in `lib/reach/ui.mjs` (`consolePageHtml` + `personRowHtml`); the design
source of truth is the parent dashboard `follow/output/dashboard.html`.

## Palette

Fixed dark theme (fillow has no light mode — do not re-add `prefers-color-scheme`).

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#100f0c` | page background |
| `--panel` | `#181612` | cards, sections, nav chrome |
| `--ink` | `#f4efe6` | primary text |
| `--mute` | `#9c9488` | secondary text, hints, table meta |
| `--line` | `#2a261f` | borders, row separators |
| `--gold` | `#e0a14a` | attention/identity: practice-mode badge, nav underline, primary accents |
| `--moss` | `#7dba7a` | good state: verified facts, live, success flash |
| `--rose` | `#d46a5c` | danger state: paused, fact-check failures, destructive buttons |

## Typography

Loaded once per page from Google Fonts:

```
https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@1,9..144,560&family=IBM+Plex+Sans:wght@400;500;600&display=swap
```

with preconnect links to `fonts.googleapis.com` and `fonts.gstatic.com` first.

- **Headings & the wordmark**: Fraunces, italic, weight 560 (`h1.mark`, `h2`)
- **Everything else**: IBM Plex Sans 400/500/600 (`body { font: 15px/1.45 "IBM Plex Sans", ... }`)
- Muted/technical text (job refs, timestamps) uses the mono/system stack with the `--mute` color.

## Layout

- `.wrap` — page container: `max-width: 1120px; margin: 0 auto; padding: 28px 28px 64px` (mobile: `20px 16px 48px`)
- `header.top` — brand row: logo + wordmark + status badges; `align-items: center`, bottom padding 22px
- Sections are `--panel` cards separated by `--line` borders; one section visible at a time
- `h1.mark` also styles person names on the `/person/:id` timeline page

## Components (as shipped in `lib/reach/ui.mjs`)

| Component | Class(es) | Notes |
|---|---|---|
| Tab navigation | `nav.pipe` + `button.on` | 7-column segmented grid; `.on` = `background: #1f1c16` with the gold underline strip. Adapted to `<button>`s (downstream of fillow's `<a>`/4-col version) because tabs switch client-side — behavior identical, labels unchanged |
| Primary buttons | `.btn-gold` | the run actions: Find people to invite, Write draft messages, Check for acceptances, Today's summary |
| Secondary/destructive | `.btn-ghost`, warn/rose variant | Approve/Discard/Delete/Never contact, Pause everything |
| Status badges | `.badge` + `.badge.gold/dry/paused/busy/live` | header: Practice mode (gold), PAUSED (rose), working… |
| Verdict pills | `.pill.ok/.pill.bad/.pill.dim` | "facts verified" (moss) / "needs a fact-check" (rose) / "not checked" (muted) — the grounding verdict |
| Flash messages | `.flash.ok/.flash.err` | top of main; auto-dismiss 6s |
| Tables | plain `table` with `--line` row borders | cells render with `textContent` only |
| Inputs | `input`/`textarea` | `--panel` background, `--line` border, ink text |
| Empty states | muted `— nothing yet —` with an action hint | always say what to do next |

## Logo

- Asset: `fillow-reach/assets/fillow_logo.png` (PNG, 1254×1254, RGBA — the same
  file as the parent's `output/fillow_logo.png`, byte-identical)
- Served route: `GET /logo.png` on the console (`image/png`, `Cache-Control:
  public, max-age=86400`). It is a public GET like the page shell; mutations
  still require the session token.
- Header: next to the "fillow Reach" wordmark at 38px (`header.top img.logo`)
- Person page: 28px next to the ← console link
- Favicon: `<link rel="icon" href="/logo.png">` on both pages
- Never stretched, never recolored, never text-faked; keep the asset byte-level
  in sync with the parent's only when the parent's mark actually changes.
- The logo is a 577KB asset — always served via the route, never inlined as a
  data-URI (it would bloat every page render).

## Changing the UI without breaking it

1. The exact user-visible labels are test-pinned — do not rename buttons/tabs
   without updating `tests/reach-ui.test.mjs` and `tests/reach-dashboard.test.mjs`
   (`data-token`, `Overview`, `Invites to send`, `Messages to review`, `People`,
   `Job targets`, `History`, `Add people`, `Find people to invite`,
   `Pause everything`, `/api/state`, `I sent this`, `Approve`, `Discard`,
   `Delete`, `Preview`, `Save these people`, `Never contact`, `Resume`, and
   `src="/logo.png"` / `rel="icon" href="/logo.png"`).
2. `data-tab` values and `id="tab-*"` section ids are JS wiring — never change.
3. All data renders through `textContent`/escaped values; never introduce
   `innerHTML` on data (LLM drafts and pasted text are untrusted).
4. Run the suite after restyling:
   `cd fillow-reach && node --disable-warning=ExperimentalWarning --test tests/*.mjs`
   (273 tests; never `npm test` on this machine).
5. Eyeball against the parent: `node bin/reach.mjs ui` →
   http://127.0.0.1:4181 should read as the same family as
   `open follow/output/dashboard.html`.
