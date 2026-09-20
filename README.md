# Opifer

**A single system where AI agents work, learn and are governed like a real organisation.**

One installation, one database, one interface. Agents learn from the work they do, the organisation governs them, the operator sees costs and results in real time.

Opifer is a [NextEpochs](https://nextepochs.com) product. Website and documentation: [opifer.dev](https://opifer.dev).

> Status: **under construction** (milestone M2, governance). The repository is private until the end of the MVP.

## Quick start

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

Opifer is a company you walk through, not an admin panel. With the server running (`pnpm o4r up --detach`) the web interface at the server address has six sections: **Home** (a board of widgets you can drag, resize and add to: what needs you, spend against the cap, who is working, recent results, activity), **Inbox** (every decision a person has to take, explained in plain words, with one-click answers and keyboard shortcuts), **Team** (agents as colleagues: hire, pause, permissions, budget, revision history), **Chat** (talk to an agent; approvals appear in the thread, the workbench shows cost and files), **Money** (costs by agent and model, caps) and **Settings**. A *Simple / Advanced* switch keeps the same screens and adds the technical layer for power users. English by default, Italian available, dark and light themes.

To look at the interface with scripted agents and no real model: `pnpm build && node packages/server/dist/preview.js` and open http://127.0.0.1:4790.

### Talking to an agent

Agents are hired from the Team page and you can talk to them from the Chat page or from the terminal:

```bash
pnpm o4r chat "Agent name"           # new conversation
pnpm o4r chat --resume <session id>  # resume a conversation
```

Every conversation is persisted: it survives a restart and resumes from the saved history without re-running tools.

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

Docker will instead serve as the default sandbox for the commands executed by the agents (from milestone M5).

## Monorepo structure

| Package | Contents |
| --- | --- |
| `packages/core` | Domain model, invariants, events |
| `packages/db` | Schema, forward and backward migrations, embedded Postgres |
| `packages/runtime` | Agent loop, model providers, context |
| `packages/gateway` | Governance: budget reservation, permissions, approvals, secrets, governed tool executor |
| `packages/server` | HTTP API `/v1`, WebSocket events |
| `packages/ui` | Web interface (React, Vite, Tailwind; NextEpochs look, dnd-kit widget board) |
| `packages/cli` | The `o4r` command |
| `packages/sdk` | Contracts for plugins, channels, providers (MIT) |
| `plugins/*` | Plugins maintained by NextEpochs (MIT): Anthropic, OpenAI (API key and ChatGPT sign-in), OpenAI-compatible endpoints |

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
