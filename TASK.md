# TASK — M5 optional (bsk, approval ramp, health apply)

You are implementing **only M5**. Defaults must stay `send_mode: queue` and `approval_mode: review`. No anti-bot evasion.

**Full plan:** `fillow-reach/docs/plans/2026-10-02-fillow-reach-m5.md`
**Spec:** PRD R1-6/R1-7, R3-7, §7 health guard, §14 M5

## Done when

- bsk path requires `data/reach/BSK_ACK`; warning/captcha → PAUSE
- `sample` / `auto` after N clean approvals; grounding failure demotes (event, do not rewrite profile.yaml)
- `healthGuard.halfTargets` / `emailPaused` applied at send time

## Tasks (TDD)

1. bsk-send + auto-pause (injectable bskImpl)
2. approval-ramp
3. assertSendAllowedHealthy
4. doctor warn rows for bsk ack / binary

## Test

```bash
cd fillow-reach
node --disable-warning=ExperimentalWarning --test tests/*.mjs
```

Never `npm test`. Fake identities only. All new files under `fillow-reach/`.
