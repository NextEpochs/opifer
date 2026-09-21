# Security review (1.0.0)

What Opifer protects, how, and what it does not do yet. Reviewed before the first release; to be revisited at every milestone.

## Two modes

**Local mode** (the default of `o4r init`): one machine, one team, the server on `127.0.0.1`, **no authentication**. Whoever reaches the port is the owner. Do not expose the port in this mode; `o4r doctor` warns when the server listens on every interface.

**Authenticated mode** (`o4r auth enable --email you@example.com`, or `o4r init --auth --email …`): every call to the API and the interface needs a signed-in person or an API key. This is the mode for a server or a VPS.

- People sign in with email and password. Passwords are hashed with scrypt (N=16384, r=8, p=1, 64-byte key, random salt) and never stored or logged in clear. At least 8 characters.
- The interface keeps a session in an `HttpOnly`, `SameSite=Lax` cookie, `Secure` when the request arrived over HTTPS (through the proxy's `X-Forwarded-Proto`). Sessions last 30 days, sliding; a changed password or a disabled account ends every session of that person.
- Ten failed sign-ins a minute per address, then 429.
- API keys (`opk_…`) for the CLI and integrations: shown once, stored as a SHA-256 hash, revocable, with a role.
- Roles are server-wide in this version (one team per server): **observer** reads, **operator** does the daily work (chat, tasks, approvals, running a routine), **admin** configures (agents, budgets, permissions, secrets, connections, learning, routines), **owner** manages people, API keys, the emergency stop and export/import. The last owner cannot be removed.
- The CLI on the server uses its own owner key in `<home>/credentials/cli.key` (mode 0600), written by `o4r auth enable`.
- Public without a sign-in: `/v1/health`, `/v1/auth/login`, the inbound webhooks (`/v1/hooks/*`, guarded by their own tokens) and the interface files.

Put a reverse proxy with TLS in front (nginx, Caddy); bind Opifer to `127.0.0.1` and let the proxy reach it. The server trusts the proxy's `X-Forwarded-*` headers in authenticated mode (`o4r auth enable --no-trust-proxy` if there is none). The interface works at the root or under a path (`https://example.com/opifer/`). An nginx example is in the ten-minute guide.

## Secrets

- Values are encrypted at rest with AES-256-GCM under a per-company key derived (HKDF) from a master key in `~/.opifer/credentials/master.key` (mode 0600), versioned.
- The API never returns a value. Agents get secrets only as environment variables of a tool call, only when bound to that agent (and optionally that tool), and every access is logged.
- Tool output is redacted: a value that leaks into a command's output comes back as `[redacted:NAME]`, never into messages, model context, events or audit.
- Exports carry secret names only.

## Model calls

- Budget is reserved **before** every model call; a reached cap stops the agent before the next call. Reservations are serialised per company.
- The system prompt is a stable prefix: nothing an agent reads (files, tool output, web pages) is ever written into it. Context files loaded from the working folder are capped.
- Prompt injection through tool output is contained by governance: every tool call passes permissions, approvals and the dangerous-command classifier regardless of what the model was told.

## Tools and sandbox

- Permissions per role and agent; low and medium risk automatic, high risk asks; a policy can block a tool.
- Dangerous commands (recursive deletion, sudo, force push, destructive git, DROP, chmod loosening, publishing, kill…) always ask, whatever the policy. Some patterns are refused outright.
- Since 1.3 the sandbox network is **on** by default (agents install, build, push); `"sandbox": { "network": "none" }` in `config.json` isolates it.
- `run_coder` (Claude Code or the Codex CLI) runs on the machine, not in the sandbox, and inside the project folder; it is a high-risk tool, so it asks for approval unless a policy allows it.
- Repository tokens (`GITHUB_TOKEN`) reach git through a helper script as a bound secret of the agent; they are never written into `.git/config` nor shown to the model.
- Files of a task's folder are served by the API to signed-in people only (observer and up), never outside that folder.
- A mailbox connection keeps its password as a company secret; `send` is a high-risk tool (approval unless allowed), `list`/`read`/`search` are low. Messages are read over IMAP with TLS and never stored by Opifer beyond the tool output in the session.
- The browser (`browser_*`, Chrome or Chromium on the machine, headless, driven through Playwright) runs as the server's user with a fresh profile per session: no cookies, passwords or history of anybody. Every request it makes is checked like `web_fetch` (public addresses only, http(s) only); clicking, typing and selecting are medium risk; a session's browser closes after ten minutes idle. Screenshots are files of the task folder.
- `web_fetch` resolves the host first and refuses private, loopback, link-local and carrier-grade addresses at every redirect, so an agent cannot reach the services next to Opifer on the machine or its network; pages are capped at 5 MB and only http(s).
- With Docker available, commands run in a container with **no network**, only the task's working folder mounted. Without Docker they run on the machine as the server's user: the interface, `o4r doctor` and `/v1/health` say so.
- MCP servers run as the server's user with the environment you give them; treat a connection like installing software. Workflow tools call only the URL you configured.

## Inbound and outbound

- Webhook tokens are shown once and stored hashed (SHA-256); comparison is constant-time; 60 calls a minute per address; a webhook can be rotated or disabled.
- Outbound events are signed `X-Opifer-Signature: t=<unix>,v1=HMAC-SHA256(secret, "<unix>.<body>")`; verify the signature and reject stale timestamps. Session events are never sent.
- Telegram: unknown senders get a pairing code and nothing else; only a person who enters the code in Opifer links that chat. One-tap approvals act as that person.

## Interface

- Security headers on every answer: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a Content-Security-Policy for the interface (`default-src 'self'`, no inline scripts, connections only to the same origin and its WebSocket).
- Preferences and layouts are stored server-side under the person; nothing sensitive is kept in the browser. In authenticated mode the session cookie is the only thing the browser holds, and scripts cannot read it.

## Data

- Every table carries `company_id`; queries filter by it; the isolation is covered by contract tests.
- The audit log accepts inserts only. Learned memories and skills are never deleted (retired, superseded, archived).
- Context compression is the only change ever made to a session's past, and it is recorded (`session_compressions`).

## Update check

Once a day the server asks `registry.npmjs.org` for the latest `@opifer/cli` version, with a plain GET and no data of the installation. `"updates": { "check": false }` in `config.json` turns it off.

## Emergency stop

`POST /v1/companies/:id/stop`, `o4r stop` or the red button: every running turn of the company is interrupted, routines are not claimed, budget reservations are denied, until a person resumes.

## Known gaps

- Roles are server-wide: two teams on one server see each other's companies. Per-company roles come next.
- No rate limit on the API beyond the sign-in and the webhooks.
- No second factor on the sign-in; no password reset by email (an owner sets a new password with `o4r user password`).
- The Docker sandbox shares the host's kernel; a hardened runtime (gVisor, Firecracker) is a deployment choice.
- Telegram is the only channel; its long polling runs inside the server.
- Dependencies are pinned by the lockfile; a supply-chain audit (`pnpm audit`) is part of CI, not of the release gate yet.
