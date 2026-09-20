# Changelog

All notable changes to Opifer. The format follows Keep a Changelog; versions follow SemVer.

## 1.0.0 — 2026-09-20 — the public release

The repository is public, the website is up at [opifer.dev](https://opifer.dev), and everything the README says has been verified on a second machine. No breaking change from 0.1.0: the version says the product is ready to be tried.

### Added
- Website `site/` (home, the guides rendered from `docs/`), built with `node site/build.mjs`.
- `CONTRIBUTING.md`, `CLA.md` (contributor licence agreement, sign-off on every commit checked by a workflow), `SECURITY.md` with private vulnerability reporting, issue forms and a pull request template.
- The task form creates a project inline.
- `DockerEnvironment` option `user`: on Linux the sandbox runs as the server's user, so files written under the task folder belong to it on the host.

### Fixed
- The container image did not build (`pnpm prune --prod` without a TTY) and then did not start (`commander`, then `@opifer/db` missing from a production install); verified on Linux with Docker 29: start, demo, restart, recovery after a kill.
- `docker-compose.yml` published the port on every interface; it binds `127.0.0.1` now.
- `o4r up` refused to start after a container restart because the stale pid file pointed at pid 1, its own pid.
- After a server restart every wake-up left running went back to the queue without comparing the database clock with the process clock (a random CI failure).
- `GET /v1/sessions/:id` with a malformed id answered 500; it answers 400.
- The CLI printed `0.0.0.0` in URLs when listening on every interface.

### Changed
- The demo company is called Proclive.

## 0.1.0 — 2026-09-20 — the MVP

The first release: the scene in section 16.1 of the specification runs end to end, in tests and live.

### Foundations (M0)
- pnpm/TypeScript strict monorepo, embedded PostgreSQL, forward and backward SQL migrations mirrored by a Drizzle schema and a test, immutable audit log, `company_id` on every domain table, `/v1` API, `o4r` CLI, React interface, CI on Linux and macOS, third-party notices generated.

### Runtime (M1)
- Phased agent loop with a stable prompt prefix, retries and fallback model, no tool replay after a restart, native tools (terminal, files, search, ask), operator injection mid-turn.
- Providers: Anthropic, OpenAI (API key and ChatGPT subscription sign-in), OpenAI-compatible endpoints for local models.

### Governance (M2)
- Budget reserved before every model call, caps per company/agent/project/task/turn with monthly/daily/lifetime windows; approvals; permissions per role and agent; dangerous commands always ask; encrypted, versioned secrets injected only into tool calls and redacted from output; every agent change is a revision.

### Work (M3)
- Goals, projects, tasks with atomic checkout and leases; delegation downward; delivery for review; done means verified; comments and mentions; wake-ups as the at-most-once queue; the scheduler.
- Interface: Home board of widgets, Inbox, Team as an org chart with drag-and-drop hiring, Work board, Chat, Money, Settings; English and Italian; dark and light.

### Learning (M4)
- Memories and skills at agent, team and company scope; snapshot in the prompt; background review on a copy of the conversation; curator; promotion under a company policy; a repeated job costs 45% less in the test suite.

### Connections and routines (M5)
- Routines (interval, cron, once) at most once per due time, in a session or as a task the agent delegates and gets reviewed; delegation closes the loop (the delegator reviews, approves or sends back).
- MCP servers and workflow endpoints as governed tools; inbound webhooks with hashed tokens; outbound signed events with retries; Telegram bot with pairing codes and one-tap approvals; Docker sandbox with no network when available.

### The complete MVP interface and robustness (M6)
- Emergency stop; two-line context compression, traced; agents can act in a conversation (company status, hand out work).
- Preferences on the server; plurals; money by language; installable app (PWA); WCAG 2.1 AA with zero axe violations on every page; Italian parity test.

### Finishing (M7)
- Company export and import; demo company; `o4r doctor` extended; quickstart and security review; load test (20 agents, 200 tasks, 10 concurrent runs on 2 vCPU: 220 runs in 13 s, none failed); scene 16.1 as a contract test.
