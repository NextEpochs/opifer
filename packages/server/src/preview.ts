/**
 * Preview server for the interface: an embedded database, a scripted fake
 * provider and governance, with a small company already in place. For
 * looking at screens and for end-to-end checks; never for real work.
 *
 *   node packages/server/dist/preview.js [port]
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase } from "@opifer/db/testing";
import { ProviderRegistry } from "@opifer/runtime";
import { FakeProvider } from "@opifer/runtime/testing";
import { buildApp } from "./app.js";

const port = Number(process.argv[2] ?? 4790);
const db = await createTestDatabase();
const provider = new FakeProvider((request) => {
  const last = request.messages.at(-1)!;
  const toolResult = last.content.find((p) => p.type === "tool_result");
  if (toolResult && toolResult.type === "tool_result") return { kind: "text", text: `Done. The command printed: ${toolResult.content.split("\n")[0]}` };
  const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  if (/build|run|deploy/i.test(text)) return { kind: "tools", text: "On it — I need to run a command first.", calls: [{ name: "terminal", arguments: { command: "rm -r build && pnpm build" } }] };
  return { kind: "text", text: `Sure. Here is what I would do about “${text}”: draft it, check it, and report back with numbers.` };
});
const dir = await mkdtemp(path.join(tmpdir(), "opifer-preview-"));
const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
const app = await buildApp({
  db,
  mode: "local",
  uiDir,
  providers: { providers: new ProviderRegistry().register(provider), defaultModel: "fake/echo", fallbackModel: null, report: [{ id: "fake", enabled: true, detail: "scripted preview provider" }] },
  workRoot: path.join(dir, "work"),
  governance: { credentialsDir: path.join(dir, "credentials") },
});
app.opifer.governance!.prices.set("fake/echo", { inputPerMillion: 3, outputPerMillion: 15, currency: "USD" });

const company = (await app.inject({ method: "POST", url: "/v1/companies", payload: { name: "NextEpochs", mission: "AI-powered software for small companies" } })).json() as { id: string };
const philip = (await app.inject({ method: "POST", url: `/v1/companies/${company.id}/agents`, payload: { name: "Philip", role: "CEO. Plans the work, delegates, reports to Mike." } })).json() as { id: string };
const nora = (await app.inject({ method: "POST", url: `/v1/companies/${company.id}/agents`, payload: { name: "Nora", role: "Researcher. Reads, compares and summarises.", reportsToAgentId: philip.id } })).json() as { id: string };
await app.inject({ method: "POST", url: `/v1/companies/${company.id}/agents`, payload: { name: "Leo", role: "Copywriter. Writes in Italian and English.", reportsToAgentId: philip.id } });
await app.inject({ method: "PUT", url: `/v1/companies/${company.id}/budgets`, payload: { scopeKind: "company", cap: 50 } });
await app.inject({ method: "PUT", url: `/v1/companies/${company.id}/budgets`, payload: { scopeKind: "agent", scopeId: nora.id, cap: 5 } });

const s1 = (await app.inject({ method: "POST", url: `/v1/companies/${company.id}/sessions`, payload: { agentId: philip.id, title: "Rebuild the website" } })).json() as { id: string };
await app.inject({ method: "POST", url: `/v1/sessions/${s1.id}/messages`, payload: { text: "Rebuild the website with the new pricing page and make sure the build passes." } });
const s2 = (await app.inject({ method: "POST", url: `/v1/companies/${company.id}/sessions`, payload: { agentId: nora.id, title: "Competitor pricing" } })).json() as { id: string };
await app.inject({ method: "POST", url: `/v1/sessions/${s2.id}/messages`, payload: { text: "Compare the pricing pages of our six closest competitors." } });

await app.listen({ host: "127.0.0.1", port });
console.log(`preview on http://127.0.0.1:${port}  (company ${company.id})`);
