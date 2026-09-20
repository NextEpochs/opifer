# Changelog

All notable changes to Opifer. The format follows Keep a Changelog; versions follow SemVer.

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
