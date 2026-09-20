/**
 * Load test (M7 acceptance): 20 agents and 10 concurrent runs on a small
 * machine. A scripted provider stands in for the model, with a delay that
 * mimics a real call, so the test exercises Opifer — scheduler, leases,
 * governance, database — not the model.
 *
 *   pnpm build && node packages/server/scripts/load-test.mjs [tasks=60] [concurrency=10]
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cpus, totalmem } from "node:os";
import { createTestDatabase } from "@opifer/db/testing";
import { ProviderRegistry } from "@opifer/runtime";
import { FakeProvider } from "@opifer/runtime/testing";
import { buildApp } from "@opifer/server";

const TASKS = Number(process.argv[2] ?? 60);
const CONCURRENCY = Number(process.argv[3] ?? 10);
const AGENTS = 20;
const MODEL_DELAY_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = await createTestDatabase({ poolMax: 20 });
let modelCalls = 0;
const provider = new FakeProvider((request) => {
  modelCalls++;
  const last = request.messages.at(-1);
  const toolResult = last.content.find((p) => p.type === "tool_result");
  if (toolResult) {
    if (toolResult.content.startsWith("Task:")) return { kind: "tools", calls: [{ name: "write_file", arguments: { path: "notes.md", content: `# Notes\n${"x".repeat(400)}` } }] };
    if (toolResult.content.startsWith("Wrote")) return { kind: "tools", calls: [{ name: "task_deliver", arguments: { summary: "Notes written", verification: "open notes.md" } }] };
    return { kind: "text", text: "ok" };
  }
  const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  if (text.startsWith("You have been assigned")) return { kind: "tools", calls: [{ name: "task_status", arguments: {} }] };
  return { kind: "text", text: `echo ${text.slice(0, 30)}` };
});
// A real model takes time: the fake one waits before answering.
const complete = provider.complete.bind(provider);
provider.complete = async function* (request) {
  await sleep(MODEL_DELAY_MS);
  yield* complete(request);
};
const dir = await mkdtemp(path.join(tmpdir(), "opifer-load-"));
const app = await buildApp({
  db,
  mode: "local",
  providers: { providers: new ProviderRegistry().register(provider), defaultModel: "fake/echo", fallbackModel: null, report: [] },
  workRoot: path.join(dir, "work"),
  governance: { credentialsDir: path.join(dir, "credentials") },
  work: { scheduler: true, tickMs: 200, concurrency: CONCURRENCY },
  learning: { worker: false },
  connections: { start: false, sandbox: "local" },
});
await app.ready();
const company = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "Load Co", mission: "Carry the load" } })).json();
const agents = [];
for (let i = 0; i < AGENTS; i++)
  agents.push((await app.inject({ method: "POST", url: `/v1/companies/${company.id}/agents`, payload: { name: `Agent ${i + 1}`, role: "worker" } })).json());
await app.inject({ method: "PUT", url: `/v1/companies/${company.id}/budgets`, payload: { scopeKind: "company", cap: 1000 } });

console.log(
  `machine: ${cpus().length} vCPU, ${(totalmem() / 1024 ** 3).toFixed(1)} GB · ${AGENTS} agents · ${TASKS} tasks · ${CONCURRENCY} concurrent runs · model delay ${MODEL_DELAY_MS} ms`,
);
const started = Date.now();
const rss0 = process.memoryUsage().rss;
// 1. Tasks: every agent gets several, all at once.
for (let i = 0; i < TASKS; i++)
  await app.inject({ method: "POST", url: `/v1/companies/${company.id}/tasks`, payload: { title: `Task ${i + 1}`, assigneeAgentId: agents[i % AGENTS].id } });
// 2. Meanwhile, chat turns on every agent.
const chats = await Promise.all(agents.map((a) => app.inject({ method: "POST", url: `/v1/companies/${company.id}/sessions`, payload: { agentId: a.id } }).then((r) => r.json())));
await Promise.all(chats.map((s) => app.inject({ method: "POST", url: `/v1/sessions/${s.id}/messages`, payload: { text: "hello" } })));
let peakRss = rss0;
let inReview = 0;
for (let i = 0; i < 600; i++) {
  await sleep(500);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  const tasks = (await app.inject({ method: "GET", url: `/v1/companies/${company.id}/tasks?status=in_review` })).json();
  inReview = tasks.length;
  if (inReview >= TASKS) break;
}
const elapsed = (Date.now() - started) / 1000;
const failed = (await db.sql`SELECT count(*)::int AS n FROM runs WHERE status = 'failed'`)[0].n;
const runs = (await db.sql`SELECT count(*)::int AS n FROM runs`)[0].n;
const blocked = (await db.sql`SELECT count(*)::int AS n FROM tasks WHERE status = 'blocked'`)[0].n;
const overview = (await app.inject({ method: "GET", url: `/v1/companies/${company.id}/overview` })).json();
const t0 = Date.now();
for (let i = 0; i < 20; i++) await app.inject({ method: "GET", url: `/v1/companies/${company.id}/overview` });
const overviewMs = (Date.now() - t0) / 20;
console.log(
  JSON.stringify(
    {
      elapsedSeconds: Number(elapsed.toFixed(1)),
      tasksDelivered: inReview,
      runs,
      failedRuns: failed,
      blockedTasks: blocked,
      modelCalls,
      runsPerMinute: Number(((runs / elapsed) * 60).toFixed(1)),
      peakRssMb: Math.round(peakRss / 1024 ** 2),
      overviewMs: Number(overviewMs.toFixed(1)),
      spendEur: overview.spend?.eur ?? null,
    },
    null,
    1,
  ),
);
await app.close();
await db.destroy();
