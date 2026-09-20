# Opifer

**A single system where AI agents work, learn and are governed like a real organisation.**

One installation, one database, one interface. Agents learn from the work they do, the organisation governs them, the operator sees costs and results in real time.

Opifer is a [NextEpochs](https://nextepochs.com) product. Website and documentation: [opifer.dev](https://opifer.dev).

> Status: **under construction** (milestone M2, governance). The repository is private until the end of the MVP.

## Quick start

Ten-minute guide: [docs/quickstart.md](docs/quickstart.md). What is protected and how: [docs/security.md](docs/security.md). Changes: [CHANGELOG.md](CHANGELOG.md).

Requirements: Node.js 22 or later and pnpm 10. No other prerequisites: the PostgreSQL database is embedded.

```bash
pnpm install
pnpm build
pnpm o4r init --company "My company"   # installs the local database, applies the migrations, creates the first company
pnpm o4r up                            # starts server and interface on http://127.0.0.1:4700
```

Other commands: `pnpm o4r down`, `pnpm o4r doctor`, `pnpm o4r migrate status|up|down`.

### Models

Opifer talks to models through provider plugins. Three ways to connect one:

- **API keys** in the environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (from milestone M2 they live in the encrypted vault).
- **ChatGPT subscription** (Plus, Pro, Team, Enterprise) instead of an OpenAI API key:

  ```bash
  pnpm o4r login chatgpt                   # opens the browser; use --manual on a headless machine
  pnpm o4r init --model chatgpt/gpt-5.6-terra
  ```

  Models are then available as `chatgpt/<model>` and billed to the plan, with no per-token price. This is the same sign-in OpenAI ships in its Codex CLI: OpenAI publicly tolerates third-party tools using it, but nothing in its terms guarantees it, so use your own account, keep the credentials private (they are stored owner-only under the Opifer home) and expect OpenAI to be able to change it. `pnpm o4r logout chatgpt` removes them.
- **Local models** through any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, llama.cpp):

  ```bash
  pnpm o4r init --local-url http://127.0.0.1:11434/v1 --model local/llama3
  ```

The default model is chosen with `--model provider/model` (for example `anthropic/claude-sonnet-5`); `pnpm o4r doctor` shows which providers are active.

### The interface

Opifer is a company you walk through, not an admin panel. With the server running (`pnpm o4r up --detach`) the web interface at the server address has nine sections: **Home** (a board of widgets you can drag, resize and add to: what needs you, spend against the cap, who is working, recent results, activity), **Inbox** (every decision a person has to take, explained in plain words, with one-click answers and keyboard shortcuts: tool approvals, budget increases, deliveries to verify, blocked tasks), **Team** (an org chart: drag a role from the palette onto the person it should report to and you are hiring; drag an agent onto another to change who they report to; each agent has permissions, budget and revision history), **Work** (goals, projects and a task board you drag cards across; every task shows why it matters, what *done* means, what it cost and what was delivered), **Learning** (what the company has learned: memories to correct or retire, skills with their versions, what each job taught, the rules), **Connections** (what the agents can reach: MCP servers and workflow tools, the Telegram bot and the chats linked to it, inbound webhooks and outbound signed events; the *Routines* view in Work schedules recurring jobs), **Chat** (talk to an agent; approvals appear in the thread, the workbench shows cost and files), **Money** (costs by agent and model, caps) and **Settings**. A *Simple / Advanced* switch keeps the same screens and adds the technical layer for power users. English by default, Italian available, dark and light themes.

To look at the interface with scripted agents and no real model: `pnpm build && node packages/server/dist/preview.js` and open http://127.0.0.1:4790.

### Talking to an agent

Agents are hired from the Team page and you can talk to them from the Chat page or from the terminal:

```bash
pnpm o4r chat "Agent name"           # new conversation
pnpm o4r chat --resume <session id>  # resume a conversation
```

Every conversation is persisted: it survives a restart and resumes from the saved history without re-running tools.

### Work

Tasks are how the company gets things done: an agent is assigned a task, wakes up, works in its own session, delivers a result and a person (or a reviewer agent) verifies it. The rules are the ones of the specification: one assignee at a time, taken with an *atomic checkout* so two agents can never work the same task; a lease with a heartbeat, so a task whose agent dies goes back to the queue (and is blocked after two failures instead of looping forever); *done* only with a verified result; a parent task closes only when its children have; every task knows its *why* (mission → goal → project → parent). Comments with `@Name` wake that agent; a person's comment wakes the assignee; a task waiting for an approval resumes on the decision.

```bash
pnpm o4r task create "Write the pricing page" --agent Leo --acceptance "Copy approved; renders on mobile"
pnpm o4r task                                  # the open tasks
pnpm o4r task show <id>                        # why chain, result, subtasks, comments
pnpm o4r task comment <id> "@Nora check the prices against the public pages"
pnpm o4r task complete <id> --note "Checked on the staging site"   # request-changes, block, unblock, cancel, release
```

Agents get the matching tools (`task_status`, `task_comment`, `task_create` for delegating downward, `task_deliver`, `task_block`) and a brief that explains the task, its why chain and the rules above.

### Learning

Agents learn from their work, at three levels (agent, team, company), and knowledge rises a level only with governance. After every finished conversation or task a **background review** reads a copy of it — never the live session — and keeps what is worth keeping: short **memories** (how to work here, who prefers what, which system does what) and, when a procedure emerged, a **skill** (a `SKILL.md` in the open agent-skills format, with versions). The next session of that agent starts with a capped memory snapshot and the index of its skills; the body of a skill is loaded on demand with `skill_load`. A repeated job then costs less: in the test suite the second run of the same task is 45% cheaper.

Nothing learned is ever deleted: a memory is corrected (the old entry stays, superseded) or retired with a reason; a skill that goes unused is made inactive and then archived by the curator (only agent-made ones, never those pinned by a person), and can come back with one click. A skill that proves itself is proposed for the whole company; the company policy decides: `automatic`, `review` (a card in the Inbox, the default) or `forbidden`. Two skills with the same name are flagged, never merged by themselves.

```bash
pnpm o4r memory --agent Philip                  # what Philip remembers (his own, his teams', the company's)
pnpm o4r memory --agent Philip --query "pricing"
pnpm o4r memory add "We deploy on Fridays" --pin # company-wide, kept first in every snapshot
pnpm o4r skill --agent Philip                   # what Philip can load
pnpm o4r skill show compare-pricing
pnpm o4r skill install ./skills/release-notes   # a folder with SKILL.md (+ scripts/, references/, templates/)
pnpm o4r skill export compare-pricing ./out
pnpm o4r skill restore compare-pricing 2        # back to a version (as a new version)
pnpm o4r skill promote compare-pricing          # share it, per the company policy
pnpm o4r learning                               # the rules and the last reviews
pnpm o4r learning set promotion automatic
```

Search is full-text; when a provider that can embed is configured (OpenAI with an API key, or a local OpenAI-compatible server with an embedding model) it is also semantic. The ChatGPT subscription does not offer embeddings.

### Routines and connections

Recurring work is a **routine**: an agent, a prompt, a schedule (`every 2 hours`, `monday 9`, a cron expression, a date) and where the result goes. Every due time runs **at most once**, even across restarts and with several servers; missed due times inside the catch-up window run late, older ones are recorded as skipped. A routine runs in its own session by default (stopped for inactivity, never for its duration, no memory unless you say so); with `--as-task` every run becomes a task, so the agent can delegate to its reports, be reviewed and verified like any other work, and the run closes with the task. When an agent delegates, it becomes the reviewer of that subtask: it is woken up on delivery, checks the result and approves it (`task_approve`) or sends it back (`task_request_changes`); a parent is delivered only after its subtasks are closed.

```bash
pnpm o4r routine create "Weekly digest" --agent Philip --every "monday 9" --as-task \
  --prompt "Delegate the repository numbers to Dev and the digest to Leo, review both, deliver EN + IT."
pnpm o4r routine create "Health check" --agent Sam --every "weekdays 9" --prompt "curl the health endpoint and report."
pnpm o4r routine run "Weekly digest"      # now, outside the schedule
pnpm o4r routine runs "Weekly digest"     # what happened, run by run
```

**Connections** give the agents tools beyond the native ones, under the same gate (permissions per role, approvals, budget, audit): an **MCP server** (local command or remote URL, secrets by name) or a **workflow** (an n8n, Zapier, Make or script endpoint exposed as one tool). Tools are named `<connection>__<tool>` and carry the connection's risk. **Inbound webhooks** let an automation create a task, wake an agent, comment or decide an approval with one `POST /v1/hooks/<id>` and a bearer token shown once; **outbound events** send the company's events, signed (`X-Opifer-Signature: t=<unix>,v1=HMAC-SHA256(secret, "<unix>.<body>")`), to the URLs you subscribe, with retries. A **Telegram** bot per company lets you talk to the agents from your phone and approve with one tap: whoever writes to the bot gets a six-digit code, and nothing else, until a person links that chat in Opifer.

```bash
pnpm o4r connection add-mcp github --command npx --args "-y,@modelcontextprotocol/server-github" --secret GITHUB_TOKEN --risk medium
pnpm o4r connection add-workflow n8n_report --url https://n8n.example.com/webhook/report --secret N8N_TOKEN --description "Runs the monthly report"
pnpm o4r connection check github
pnpm o4r webhook create zapier --action create_task --agent Dev      # prints the URL and the token once
pnpm o4r webhook subscribe crm https://crm.example.com/opifer --events "task.*,approval.*"
pnpm o4r channel add-telegram --token 123456:ABC…                     # stored as the company secret TELEGRAM_BOT_TOKEN
pnpm o4r channel pair 482913                                          # the code the bot sent you
```

Commands run by the agents execute in a **Docker sandbox** (no network, the task's working folder mounted) whenever a Docker daemon is available; otherwise they run on the machine, and `o4r doctor`, `/v1/health` and the Connections page say so.

### Governance

Agents work under the same rules as people in an organisation. Everything below is also in the interface: the Inbox, the Money page and each agent's Permissions and Budget tabs.

- **Budgets.** Every model call reserves its estimated cost *before* it starts; when a cap is reached the call never happens, the agent is stopped and a *budget increase* lands in the inbox. Costs are settled per call with each provider's price list.
  ```bash
  pnpm o4r budget set --cap 20                 # 20 EUR per month for the whole company
  pnpm o4r budget set --cap 5 --agent Philip   # a tighter cap for one agent
  pnpm o4r costs                               # spending by agent and model
  ```
- **Permissions.** Every tool has one of three states per agent: `automatic`, `approval` or `blocked`. Without a policy, low and medium risk tools run automatically and high risk ones (the terminal, writing files) ask first. Dangerous commands (`rm -r`, `sudo`, `git reset --hard`, …) always ask, whatever the policy.
  ```bash
  pnpm o4r policy --agent Philip                    # what Philip may do, and why
  pnpm o4r policy set terminal automatic --agent Philip
  pnpm o4r policy set "*" blocked --role intern
  ```
- **Approvals.** A turn that needs a decision suspends; approve and it resumes exactly where it stopped, deny and the agent is told why.
  ```bash
  pnpm o4r approvals                     # the inbox
  pnpm o4r approvals approve <id>
  pnpm o4r approvals deny <id> --note "not on production"
  ```
- **Secrets.** Encrypted per company (AES-256-GCM, key derived from `credentials/master.key` in the Opifer folder), bound to an agent and optionally one tool, injected as environment variables when the tool runs and never shown to the model: their values are redacted from tool output, and every access is recorded.
  ```bash
  pnpm o4r secret set GITHUB_TOKEN               # prompted, never echoed
  pnpm o4r secret bind GITHUB_TOKEN --agent Philip --tool terminal
  ```
- **Audit and revisions.** Every one of these changes writes an immutable audit entry, and every change to an agent creates a revision that can be restored (`PATCH /v1/agents/:id`, `POST /v1/agents/:id/revisions/:n/restore`).

### In a container (optional)

Docker is not needed for the local installation. It is a deployment option for servers and cloud:

```bash
docker compose up -d      # builds the image, creates database and first company in the opifer-data volume
```

Docker is also the default sandbox for the commands executed by the agents when a daemon is available (see *Routines and connections*).

## Monorepo structure

| Package | Contents |
| --- | --- |
| `packages/core` | Domain model, invariants, events |
| `packages/db` | Schema, forward and backward migrations, embedded Postgres |
| `packages/runtime` | Agent loop, model providers, context |
| `packages/gateway` | Governance: budget reservation, permissions, approvals, secrets, governed tool executor |
| `packages/work` | Goals, projects, tasks and routines: atomic checkout, leases, results, wake-ups, at-most-once runs, task tools for agents (delegation, review) |
| `packages/learning` | Memory and skills at three scopes, snapshot for the prompt, search, versions, curator, promotion, background review |
| `packages/connections` | Tool connections (MCP servers, workflow endpoints), inbound webhooks, outbound signed events, messaging channels and pairing |
| `packages/server` | HTTP API `/v1`, WebSocket events, the scheduler that wakes agents on their tasks and routines, the learning worker, the channel hub |
| `packages/ui` | Web interface (React, Vite, Tailwind; NextEpochs look, dnd-kit widget board and task board, React Flow org chart) |
| `packages/cli` | The `o4r` command |
| `packages/sdk` | Contracts for plugins, channels, providers (MIT) |
| `plugins/*` | Plugins maintained by NextEpochs (MIT): Anthropic, OpenAI (API key and ChatGPT sign-in), OpenAI-compatible endpoints, the Telegram channel |

## The twenty invariants

Twenty rules are the contract of the system and outweigh any feature. They are listed in `packages/core/src/invariants.ts` and each one is a contract test in `packages/core/test/invariants.test.ts`, which turns green milestone after milestone.

## Development

```bash
pnpm typecheck   # type check on all packages
pnpm test        # unit and contract tests (starts a temporary embedded Postgres)
pnpm dev         # server in development mode
pnpm --filter @opifer/ui dev   # interface in development mode
```

The working rules for people and agents are in [AGENTS.md](./AGENTS.md).

## Licences

The Opifer core is distributed under the **AGPL-3.0-only** licence (see [LICENSE](./LICENSE)). The SDK (`packages/sdk`) and the plugins (`plugins/*`) are distributed under the **MIT** licence, so whoever extends Opifer is not bound by the AGPL. The NextEpochs vertical packages are proprietary and live in separate repositories.

The licences of the dependencies are collected in `THIRD-PARTY-NOTICES`, regenerated at every release with `pnpm third-party-notices`.
