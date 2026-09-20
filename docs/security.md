# Security review (MVP, 0.1.0)

What Opifer protects, how, and what it does not do yet. Reviewed before the first release; to be revisited at every milestone.

## Trust model

Opifer runs on one machine for one team (local mode). The server listens on `127.0.0.1` by default and has **no authentication**: whoever reaches the port is the owner. Do not expose the port; if you must reach it from elsewhere, put a reverse proxy with access control in front of it. `o4r doctor` warns when the server listens on every interface. Authenticated mode (users, roles, sessions) is the first item after the MVP.

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
- With Docker available, commands run in a container with **no network**, only the task's working folder mounted. Without Docker they run on the machine as the server's user: the interface, `o4r doctor` and `/v1/health` say so.
- MCP servers run as the server's user with the environment you give them; treat a connection like installing software. Workflow tools call only the URL you configured.

## Inbound and outbound

- Webhook tokens are shown once and stored hashed (SHA-256); comparison is constant-time; 60 calls a minute per address; a webhook can be rotated or disabled.
- Outbound events are signed `X-Opifer-Signature: t=<unix>,v1=HMAC-SHA256(secret, "<unix>.<body>")`; verify the signature and reject stale timestamps. Session events are never sent.
- Telegram: unknown senders get a pairing code and nothing else; only a person who enters the code in Opifer links that chat. One-tap approvals act as that person.

## Interface

- Security headers on every answer: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a Content-Security-Policy for the interface (`default-src 'self'`, no inline scripts, connections only to the same origin and its WebSocket).
- Preferences and layouts are stored server-side under the person; nothing sensitive is kept in the browser.

## Data

- Every table carries `company_id`; queries filter by it; the isolation is covered by contract tests.
- The audit log accepts inserts only. Learned memories and skills are never deleted (retired, superseded, archived).
- Context compression is the only change ever made to a session's past, and it is recorded (`session_compressions`).

## Emergency stop

`POST /v1/companies/:id/stop`, `o4r stop` or the red button: every running turn of the company is interrupted, routines are not claimed, budget reservations are denied, until a person resumes.

## Known gaps (after the MVP)

- No authentication and no per-person permissions on the API.
- No rate limit on the rest of the API (local mode).
- The Docker sandbox shares the host's kernel; a hardened runtime (gVisor, Firecracker) is a deployment choice.
- Telegram is the only channel; its long polling runs inside the server.
- Dependencies are pinned by the lockfile; a supply-chain audit (`pnpm audit`) is part of CI, not of the release gate yet.
