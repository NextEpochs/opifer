# Opifer

**A single system where AI agents work, learn and are governed like a real organisation.**

One installation, one database, one interface. Agents learn from the work they do, the organisation governs them, the operator sees costs and results in real time.

Opifer is a [NextEpochs](https://nextepochs.com) product. Website and documentation: [opifer.dev](https://opifer.dev).

> Status: **under construction** (milestone M1, runtime). The repository is private until the end of the MVP.

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

### Talking to an agent

With the server running (`pnpm o4r up --detach`), agents are created from the web interface and you can talk to them from the Chat page or from the terminal:

```bash
pnpm o4r chat "Agent name"           # new conversation
pnpm o4r chat --resume <session id>  # resume a conversation
```

Every conversation is persisted: it survives a restart and resumes from the saved history without re-running tools.

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
| `packages/gateway` | Tool registry, MCP client, permissions, budget reservation |
| `packages/server` | HTTP API `/v1`, WebSocket events |
| `packages/ui` | Web interface (React, Vite, Tailwind) |
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
