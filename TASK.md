# TASK — M3 R3 Outreach

You are implementing **only M3**. Needs accepted people + verified emails (M1). Do not implement sample/auto (M5). Do not apply health-guard throttling (report-only until M5).

**Full plan:** `fillow-reach/docs/plans/2026-10-02-fillow-reach-m3.md`
**Spec:** PRD §5 R3, §7, §11, §14 M3

## Done when

- Dry-run produces drafts
- `grounding_ok=0` never sends
- Same-day LinkedIn + email blocked
- Caps via existing `assertSendAllowed` at send time
- Reply cancels pending drafts
- Injectable SMTP (`sendMailImpl`) for tests

## Tasks (TDD)

1. Fact pack + draft eligibility / insertDraft
2. composeDraft + groundingCheck (quoted untrusted LinkedIn text)
3. CLI `approve` (`review` only; blocks grounding_ok=0)
4. sendApproved (dry-run, pause, caps, same-day defer)
5. ingestInbound cancel-on-reply + `agents/reach-outreach.mjs`

## Test

```bash
cd fillow-reach
node --disable-warning=ExperimentalWarning --test tests/*.mjs
```
