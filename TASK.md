# TASK — M1 R2 Contacts

You are implementing **only M1**. Do not start M2–M5. Do not recreate the CLI.

**Full plan:** `fillow-reach/docs/plans/2026-10-02-fillow-reach-m1.md`
**Spec:** `fillow-reach/fillow Reach — PRD & Data Schema.md` §5 R2, §6, §8, §9, §14 M1
**Index:** `fillow-reach/docs/plans/README.md`

## Done when

- Sample Connections.csv imports (`already_connected` / `lifecycle=connected`)
- Mailbox fixture flips `connection.status` to `accepted`
- Hunter find+verify behind quota/cache; 401/402/429 skip the provider for the run
- Suppression beats every other rule; `forget` + `purgeExpired` work

## Tasks (TDD)

1. `lib/reach/people.mjs` — upsertCompany, upsertPerson, isSuppressed, addSuppression, insertEmailAddress
2. `lib/reach/import-connections.mjs` — CSV + CLI `import` (`--yes` to write)
3. `lib/reach/acceptance.mjs` — acceptances + bounces, injectable fetcher
4. Hunter + provider-usage
5. CLI `contacts` / `suppress` / `forget` + `agents/reach-contacts.mjs`

**Append** rows to existing `fillow-reach/lib/reach/cli.mjs` `commands`. Remove those names from `PLANNED`.

## Test

```bash
cd fillow-reach
node --disable-warning=ExperimentalWarning --test tests/*.mjs
```

Never `npm test`. Fake identities only. All new files under `fillow-reach/`.
