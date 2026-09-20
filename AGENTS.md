# AGENTS.md — how we work in this repository

This file is read by people and by development agents. It applies to the whole monorepo.

## What Opifer is

Opifer is a platform where AI agents work, learn and are governed like an organisation. The full specification is the document "Opifer — Full specification and MVP plan" (NextEpochs, September 2026). The code is a reimplementation from the specification: we start from the described behaviours in our own words, never from someone else's code. No file, function, prompt or schema is translated or adapted from third-party projects; open standards (MCP, agent skills, OpenAPI, OpenTelemetry) are implemented from their public specifications.

## The twenty invariants

Every feature, present or future, must respect them. They are in `packages/core/src/invariants.ts` and each has a contract test in `packages/core/test/invariants.test.ts`. Before touching the core, read them again. A change that violates an invariant is not made: the specification is discussed instead.

## Code rules

- A single language: TypeScript strict, ESM modules (`NodeNext`), Node.js 22.
- All state lives in PostgreSQL. No mandatory second store.
- Every table with domain data carries `company_id`, `created_at`, `updated_at`. `audit_log` accepts inserts only.
- Migrations are pairs of SQL files `NNNN_name.up.sql` / `NNNN_name.down.sql` in `packages/db/migrations`; every `up` has its `down` and the pair is exercised in both directions by the `migrate.test.ts` test. The Drizzle schema in `packages/db/src/schema.ts` mirrors the migrations and serves the typed queries.
- Files under 1,500 lines, functions under 200. No test that snapshots values meant to change.
- Everything in English for now: names, code identifiers, interface texts and documentation. The interface stays bilingual, with English as the default and Italian as the second locale.
- Secrets never enter the repository, the logs or the context of a model.
- Every dependency comes in with a licence compatible with commercial distribution; `THIRD-PARTY-NOTICES` is regenerated with `pnpm third-party-notices`.

## Commands

```bash
pnpm install && pnpm build
pnpm typecheck
pnpm test
pnpm o4r init --company "Company name"
pnpm o4r up
```

## Way of working

- The plan is in milestones (M0..M7). Every milestone closes with a demonstration and with the contract tests of the invariants it touches.
- The UI grows with every milestone, one page at a time.
- No feature from the "Later" column of the roadmap enters the MVP without removing another one.
- Commits describe the changed behaviour, in English, with a reference to the milestone (e.g. `M0: forward and backward migrations`).

## Licences

Core AGPL-3.0-only; `packages/sdk` and `plugins/*` MIT. Do not move code between the two areas without an explicit decision.
