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
  // No scheduler: the seeded tasks keep the states below, so screens are stable.
  work: { scheduler: false },
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

// Work: a goal, two projects and tasks in every state, so the board and the inbox have something to show.
const work = app.opifer.work;
const mike = { kind: "person" as const, id: null };
const goal = await work.createGoal({ companyId: company.id, title: "Launch the new website by October", description: "A site that explains the product and converts.", measure: "Site live, 100 sign-ups in the first month." }, mike);
const site = await work.createProject({ companyId: company.id, name: "Website", description: "The public site and the pricing page.", goalId: goal.id }, mike);
const research = await work.createProject({ companyId: company.id, name: "Market research", description: "What the competitors do and charge.", goalId: goal.id }, mike);
const leo = (await app.inject({ method: "GET", url: `/v1/companies/${company.id}/agents` })).json() as Array<{ id: string; name: string }>;
const leoId = leo.find((a) => a.name === "Leo")!.id;

const pricing = await work.createTask({ companyId: company.id, projectId: site.id, title: "Write the pricing page", description: "Three plans, one clear recommendation, no jargon.", acceptance: "Copy approved by Mike; renders on mobile.", priority: "high", assigneeAgentId: leoId }, mike);
await work.checkout(company.id, pricing.id, { agentId: leoId });
const compare = await work.createTask({ companyId: company.id, projectId: research.id, title: "Compare competitor pricing", description: "Six closest competitors: plans, prices, limits.", acceptance: "A table with sources for every number.", priority: "normal", assigneeAgentId: nora.id }, mike);
await work.checkout(company.id, compare.id, { agentId: nora.id });
await work.addProduct(company.id, compare.id, { kind: "document", title: "competitor-pricing.md", ref: "docs/competitor-pricing.md", summary: "Six competitors compared, with sources." }, { kind: "agent", id: nora.id });
await work.requestReview(company.id, compare.id, { summary: "Compared six competitors; the median price is 29 EUR a month. Table with sources attached.", verification: "Every price checked on the public pricing page on 18 September." }, { kind: "agent", id: nora.id });
const analytics = await work.createTask({ companyId: company.id, projectId: site.id, title: "Set up analytics", description: "Privacy-friendly analytics on every page.", priority: "normal", assigneeAgentId: philip.id }, mike);
await work.checkout(company.id, analytics.id, { agentId: philip.id });
await work.block(company.id, analytics.id, "I need the analytics account credentials; none is configured.", { kind: "agent", id: philip.id });
const domain = await work.createTask({ companyId: company.id, projectId: site.id, title: "Choose the domain name", priority: "urgent", assigneeAgentId: philip.id }, mike);
await work.checkout(company.id, domain.id, { agentId: philip.id });
await work.complete(company.id, domain.id, { summary: "Registered nextepochs.ai; DNS points to the new host.", verification: "dig shows the new records; the site answers over HTTPS." }, { kind: "agent", id: philip.id });
await work.createTask({ companyId: company.id, projectId: site.id, title: "Design the home page", description: "Hero, three benefits, one call to action.", priority: "high", assigneeAgentId: leoId }, mike);
await work.createTask({ companyId: company.id, projectId: site.id, title: "Write the FAQ", priority: "low" }, mike);
await work.createTask({ companyId: company.id, projectId: research.id, title: "Interview five customers", description: "What made them choose us, what almost stopped them.", priority: "normal", assigneeAgentId: nora.id }, mike);
await work.comment(company.id, pricing.id, mike, "Keep the middle plan as the recommended one.");
await work.comment(company.id, pricing.id, { kind: "agent", id: leoId }, "Understood — drafting three plans now, middle one highlighted.");

await app.listen({ host: "127.0.0.1", port });
console.log(`preview on http://127.0.0.1:${port}  (company ${company.id})`);
