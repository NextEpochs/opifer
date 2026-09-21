# Changelog

All notable changes to Opifer. The format follows Keep a Changelog; versions follow SemVer.

## Unreleased

### Added
- Email as a connection: a mailbox per company (SMTP to send, IMAP to read), the password a company secret. The agents get `<name>__send` (high risk: a person approves each email unless the policy allows it), `<name>__list`, `<name>__read` and `<name>__search`. Connections → Tools → Add a mailbox; `o4r connection add-email <name> --smtp host:port --imap host:port --user … --from …`. Migration `0012_email_connections`.

### Fixed
- The CLI declared a JSON body on calls that send none, so `o4r connection check|remove`, `o4r resume`, `o4r routine run`, `o4r skill restore` and the chat interrupt answered `Bad Request` in 1.3.0.

## 1.3.0 — 2026-09-21 — software work and artifacts

### Added
- Projects can be git repositories (`repoUrl`, `branch`): cloned into the project's folder at creation, with the company's `GITHUB_TOKEN` for private ones; agents push with a token bound to them through a credential helper, never stored in the repository. `o4r project list|create --repo --branch`; repository URL and branch on the project form, clone status on the project.
- Tools for software: `edit_file` (exact replacement), `apply_patch` (unified diff), and `run_coder`, which hands a brief to Claude Code or the Codex CLI installed on the machine and reports the summary and the diff stat (found on the PATH at start, or `coder` in `config.json`; high risk). Tasks on a repository carry an engineer's guide; the terminal sets git up and can run up to 30 minutes.
- Artifacts: everything the agents produced, in the task panel (products declared at delivery, files of the task folder, open or download) and in Work → Artifacts for the whole company; `GET /v1/companies/:id/artifacts`, `GET /v1/tasks/:id/files[/path]`; `o4r artifacts`, `o4r task files <id> [path]`.
- Archive an agent from the Team page (Archive / Bring back, an Archived list) and `o4r agent list|pause|resume|archive|restore`.

### Changed
- The default sandbox image is `node:22-bookworm` (git, curl, python, build tools) with the network on; `"sandbox": { "network": "none" }` isolates it.
- No made-up default model: without a connected provider the interface, the CLI and the runtime say so.
- Migration `0011_project_repos`.

## 1.2.0 — 2026-09-21 — updating

### Added
- `o4r update`: installs the latest `@opifer/cli` from npm where this one is installed and restarts the server (under systemd or launchd the service comes back by itself); `--check` only says whether a newer version exists; from a repository checkout it prints the git and pnpm commands.
- The server looks at npm once a day for a newer version (`updates.check: false` in `config.json` turns it off; nothing else leaves the machine); the health check, `o4r doctor` and Settings say when one is out.

### Fixed
- The interface is English by default whatever the browser language; Italian is chosen in Settings (1.1.1 of the interface).
- The hidden password prompt of `o4r user password` and `o4r auth enable` failed in a terminal (1.1.2 of the CLI); `o4r doctor` crashed on the companies list in authenticated mode (1.1.1 of the CLI).

## 1.1.0 — 2026-09-20 — authenticated mode

Opifer can now run on a server or a VPS: `o4r init --auth --email you@example.com` (or `o4r auth enable`) and every call to the interface and the API needs a signed-in person or an API key.

### Added
- People with email and password (scrypt), session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` behind HTTPS, 30 days sliding), ten failed sign-ins a minute per address.
- API keys (`opk_…`) for the CLI and integrations, shown once, stored hashed, revocable.
- Roles, server-wide: observer reads, operator does the daily work, admin configures, owner manages people, keys, the emergency stop and export/import. The last owner cannot be removed.
- CLI: `o4r auth enable|disable|status`, `o4r user add|list|remove|password|role`, `o4r apikey create|list|revoke`; `o4r init --auth --email --password`; the CLI signs its own calls with a key in `<home>/credentials/cli.key`.
- Interface: sign-in screen, the signed-in person in the sidebar, sign-out in Settings; preferences per person.
- The interface works under a path (`https://example.com/opifer/`): relative assets, API, events socket and service worker.
- Docker: `OPIFER_AUTH_EMAIL` and `OPIFER_AUTH_PASSWORD` turn authenticated mode on at first start.
- Migration `0010_auth`: `users.password_hash|role|status|last_login_at`, `user_sessions`, `api_keys`.

### Changed
- `o4r doctor` reports the authentication mode instead of warning about exposure when sign-in is on.
- The guide has a section "On a server" with the nginx snippet; the security review describes both modes.

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
