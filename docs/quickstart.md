# Opifer in ten minutes

You need Node.js 22. Nothing else: the database is embedded, Docker is optional.

## 1. Install

```bash
npm install -g @opifer/cli        # the o4r command
o4r init --company "My company"
```

Prefer the repository (to develop, or to run the latest main)? `git clone https://github.com/NextEpochs/opifer.git && cd opifer && pnpm install && pnpm build`, then every `o4r` command below as `pnpm o4r …`.

`o4r init` writes the configuration in `~/.opifer`, starts the embedded PostgreSQL, applies the migrations and creates your company. Give it a model:

- **Anthropic**: `export ANTHROPIC_API_KEY=…`
- **OpenAI with a key**: `export OPENAI_API_KEY=…`
- **OpenAI with your ChatGPT subscription**: `o4r login chatgpt` (a browser opens; no key needed)
- **A local model**: `o4r init --local-url http://127.0.0.1:11434/v1` (Ollama, LM Studio, vLLM…)

Then:

```bash
o4r up --detach
o4r doctor                        # every check green?
```

Open http://127.0.0.1:4700.

## 2. Look around with a company already at work

```bash
o4r demo
```

This creates a demo company with four agents, a goal, two projects, tasks in every state, memories, skills, two routines, a workflow connection, a webhook and a subscription — no model is called. Pick it in **Settings**, then walk through Home, Inbox, Team, Work, Learning and Connections.

## 3. Your first agent and your first task

In **Team**, drag a role from the palette onto *You*: that is a hire. Give it a name and a job description in plain words ("Researcher. Reads, compares, summarises; every number comes with its source.").

In **Work**, press *New task*: a title, what to do, what *done* means, who does it. The agent wakes up at once. If it needs to run a command that asks for approval, the card appears in your **Inbox** (and on your phone, if Telegram is connected): approve or deny with one click. When the agent delivers, the result waits for your verification: *Verify and close* closes it; *Request changes* sends it back with a note.

An agent you no longer need is archived from their panel in **Team** (or `o4r agent archive Name`): they stop working and leave the org chart; their history, costs and what they learned stay, and *Bring back* rehires them.

Talk to any agent in **Chat**. Ask "how are things in the company?": the agent reads the company status and can hand out work to its reports.

What the agents produce is under **Artifacts**: in a task's panel (the products they declared at delivery, and every file in the task's folder, to open or download) and in **Work → Artifacts** for the whole company. From the command line: `o4r artifacts`, `o4r task files <id> [path]`.

## 4. Money, permissions, learning

**Money** shows where every euro goes and lets you set caps (company, agent, project, task). When a cap is reached the agent stops *before* the next call and asks you.

Each agent's drawer in **Team** has its permissions per tool (Auto / Ask / Off). Dangerous commands (deleting folders, sudo, force push) always ask.

After every finished task a background review keeps what is worth keeping: memories and skills, in **Learning**. A repeated job costs less the second time. A skill that proves itself is proposed for the whole company, and you decide.

## The web

Agents read the web with `web_fetch` (a page as clean text, a JSON API) out of the box. For `web_search`, give the server a search provider: `BRAVE_API_KEY` (Brave Search API), `TAVILY_API_KEY`, or `SEARXNG_URL` for a SearXNG instance of yours, in the environment of `o4r up` (the systemd unit, the compose file); `o4r doctor` says which one is in use. Fetching never reaches private addresses of the machine or its network.

## Software: projects that are repositories

A project can be a git repository: give its URL (and a branch) when you create it in **Work → Projects** or with `o4r project create "Site" --repo https://github.com/org/site --branch main`. It is cloned into the project's folder; every task of the project works there. For a private repository, store a token first (`o4r secret set GITHUB_TOKEN`) and bind it to the agents that push (`o4r secret bind GITHUB_TOKEN --agent Theo --tool terminal`): git authenticates through a helper, the token never lands in the repository.

Agents write software with the terminal (network on, an image with git, curl, python and build tools), `read_file`/`write_file`, `edit_file` (exact replacement) and `apply_patch` (a diff), and they deliver a branch with commits. When Claude Code or the Codex CLI is installed on the machine that runs Opifer, agents also get `run_coder`: they hand a full brief to it and it does the multi-step work in the project folder, under the same approvals and review. Its own usage is billed to its subscription, and the result says so.

## 5. Routines and connections

In **Work → Routines** give an agent a recurring job: every day at 9, Monday at 9, every two hours, a cron expression. *Run as a task* lets the agent delegate to its reports and get reviewed. Every due time runs at most once, even after a crash.

In **Connections** add an MCP server or a workflow (n8n, Zapier, Make) as tools; create a webhook so an automation can open tasks; subscribe a URL to the company's events (signed); connect the Telegram bot of the company to talk to the agents from your phone and approve with one tap.

## Updating

```bash
o4r update            # the latest from npm, installed where this one is, and the server restarted
o4r update --check    # only tell me
```

Your data, configuration and keys stay where they are; `o4r up` applies any new migration. Under systemd the service comes back by itself after the install. From a repository checkout: `git pull --ff-only && pnpm install && pnpm build && pnpm o4r down && pnpm o4r up --detach`. With Docker: `docker compose build --pull && docker compose up -d`. The server looks at npm once a day for a newer version and Settings tells you; `"updates": { "check": false }` in `config.json` turns that off.

## 6. When something goes wrong

- **Stop everything**: the red button in the sidebar (or `o4r stop`). Every agent stops, routines pause, no model is called until you resume.
- `o4r doctor` says what is missing.
- Every step is in the audit (Home → Activity) and in the costs.
- Export your company from Settings (configuration and work, never secret values) and import it elsewhere.

## On a server

Same install, plus a sign-in and a reverse proxy with HTTPS:

```bash
npm install -g @opifer/cli
o4r init --company "My company" --port 4720 --auth --email you@example.com    # the password is prompted
o4r up --detach
```

`--auth` turns authenticated mode on: every call to the interface and the API needs a signed-in person or an API key. Add people with `o4r user add name@example.com --role operator` (observer, operator, admin, owner) and keys for integrations with `o4r apikey create n8n`. Keep the server on `127.0.0.1` and let nginx (or Caddy) reach it; the interface works at the root or under a path:

```nginx
location /opifer/ {
    proxy_pass http://127.0.0.1:4720/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

To keep it running, a systemd unit that runs `o4r up` as an unprivileged user is enough (`Restart=always`). With Docker on the server, agents' commands run in containers with no network. What is protected and how: [docs/security.md](security.md).

## Command line

```bash
o4r status                   # is it running?
o4r chat Philip              # talk from the terminal
o4r task create "Compare three CRMs" --agent Nora
o4r approvals                # what waits for you
o4r routine create "Weekly digest" --agent Philip --every "monday 9" --as-task --prompt "…"
o4r export                   # opifer-<company>.json
o4r stop / pnpm o4r resume   # emergency stop
o4r down                     # stop the server
```

Everything the interface does, the API does: `http://127.0.0.1:4700/v1/…` (see the README).
