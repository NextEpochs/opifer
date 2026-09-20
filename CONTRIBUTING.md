# Contributing to Opifer

Thank you for looking under the hood. This page says how to report, how to propose, and what a change needs before it can be merged.

## Reporting and proposing

- A bug: [open an issue](https://github.com/NextEpochs/opifer/issues/new/choose) with what you did, what happened and what you expected. The output of `pnpm o4r doctor` and the version from `/v1/health` help.
- A vulnerability: not an issue. See [SECURITY.md](SECURITY.md).
- An idea: open an issue first. Opifer follows a specification with a "later" column; a new feature enters only when another leaves, so a conversation before the code saves both of us time.

## Before you write code

Read [AGENTS.md](AGENTS.md): it is the contract of the repository, for people and for development agents. The short version:

- TypeScript strict, ESM, Node.js 22. Everything in English. Files under 1,500 lines, functions under 200.
- The twenty invariants in `packages/core/src/invariants.ts` outweigh any feature. A change that violates one is not made.
- Every migration is an `up`/`down` pair, and the Drizzle schema mirrors it.
- No secret ever enters the repository, the logs or the context of a model.
- `pnpm typecheck && pnpm test` green, `npx prettier --write` on what you touched.

Set-up:

```bash
pnpm install && pnpm build
pnpm typecheck && pnpm test          # embedded Postgres per test file, about 90 s
node packages/server/dist/preview.js # the interface with scripted agents on http://127.0.0.1:4790
```

## The agreement

Two things make a contribution mergeable, and both are there so that Opifer can stay open and still be maintained by one company:

1. **Sign off every commit** (the Developer Certificate of Origin, [developercertificate.org](https://developercertificate.org)). `git commit -s` adds the line. It states that you wrote the change, or have the right to submit it, under the licence of the file you changed.
2. **Accept the Contributor License Agreement** in [CLA.md](CLA.md) by opening the pull request. It grants NextEpochs the right to distribute your contribution under the AGPL and also under other licences, which is what allows the core to be AGPL while the SDK and the plugins are MIT, and what keeps a commercial licence possible for organisations that cannot use the AGPL.

A pull request without the sign-off is held by the check until the commits are amended. There is no bot to sign: the agreement is accepted by the act of contributing, and the sign-off is the record.

## Pull requests

- One change per pull request, with the behaviour described in the title, and the milestone or issue in the body.
- Commits describe the changed behaviour, in English.
- If the change touches the interface, add the strings in both languages: `packages/ui/test/i18n.test.ts` checks the parity.
- If the change touches an invariant, its contract test changes with it, and the reason goes in the pull request.

## Licences

The core (`packages/*` except `packages/sdk`) is AGPL-3.0-only. The SDK (`packages/sdk`) and the plugins (`plugins/*`) are MIT. Code does not move between the two areas without a decision recorded in the repository.
