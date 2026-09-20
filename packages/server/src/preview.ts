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
  if (toolResult && toolResult.type === "tool_result")
    return {
      kind: "text",
      text: `Done. The command printed: ${toolResult.content.split("\n")[0]}`,
    };
  const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
  if (/build|run|deploy/i.test(text))
    return {
      kind: "tools",
      text: "On it — I need to run a command first.",
      calls: [
        {
          name: "terminal",
          arguments: { command: "rm -r build && pnpm build" },
        },
      ],
    };
  return {
    kind: "text",
    text: `Sure. Here is what I would do about “${text}”: draft it, check it, and report back with numbers.`,
  };
});
const dir = await mkdtemp(path.join(tmpdir(), "opifer-preview-"));
const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
const app = await buildApp({
  db,
  mode: "local",
  uiDir,
  providers: {
    providers: new ProviderRegistry().register(provider),
    defaultModel: "fake/echo",
    fallbackModel: null,
    report: [{ id: "fake", enabled: true, detail: "scripted preview provider" }],
  },
  workRoot: path.join(dir, "work"),
  governance: { credentialsDir: path.join(dir, "credentials") },
  // No scheduler and no review worker: the seeded data keeps the states below, so screens are stable.
  work: { scheduler: false },
  learning: { worker: false },
});
app.opifer.governance!.prices.set("fake/echo", {
  inputPerMillion: 3,
  outputPerMillion: 15,
  currency: "USD",
});

const company = (
  await app.inject({
    method: "POST",
    url: "/v1/companies",
    payload: {
      name: "NextEpochs",
      mission: "AI-powered software for small companies",
    },
  })
).json() as { id: string };
const philip = (
  await app.inject({
    method: "POST",
    url: `/v1/companies/${company.id}/agents`,
    payload: {
      name: "Philip",
      role: "CEO. Plans the work, delegates, reports to Mike.",
    },
  })
).json() as { id: string };
const nora = (
  await app.inject({
    method: "POST",
    url: `/v1/companies/${company.id}/agents`,
    payload: {
      name: "Nora",
      role: "Researcher. Reads, compares and summarises.",
      reportsToAgentId: philip.id,
    },
  })
).json() as { id: string };
await app.inject({
  method: "POST",
  url: `/v1/companies/${company.id}/agents`,
  payload: {
    name: "Leo",
    role: "Copywriter. Writes in Italian and English.",
    reportsToAgentId: philip.id,
  },
});
await app.inject({
  method: "PUT",
  url: `/v1/companies/${company.id}/budgets`,
  payload: { scopeKind: "company", cap: 50 },
});
await app.inject({
  method: "PUT",
  url: `/v1/companies/${company.id}/budgets`,
  payload: { scopeKind: "agent", scopeId: nora.id, cap: 5 },
});

const s1 = (
  await app.inject({
    method: "POST",
    url: `/v1/companies/${company.id}/sessions`,
    payload: { agentId: philip.id, title: "Rebuild the website" },
  })
).json() as { id: string };
await app.inject({
  method: "POST",
  url: `/v1/sessions/${s1.id}/messages`,
  payload: {
    text: "Rebuild the website with the new pricing page and make sure the build passes.",
  },
});
const s2 = (
  await app.inject({
    method: "POST",
    url: `/v1/companies/${company.id}/sessions`,
    payload: { agentId: nora.id, title: "Competitor pricing" },
  })
).json() as { id: string };
await app.inject({
  method: "POST",
  url: `/v1/sessions/${s2.id}/messages`,
  payload: {
    text: "Compare the pricing pages of our six closest competitors.",
  },
});

// Work: a goal, two projects and tasks in every state, so the board and the inbox have something to show.
const work = app.opifer.work;
const mike = { kind: "person" as const, id: null };
const goal = await work.createGoal(
  {
    companyId: company.id,
    title: "Launch the new website by October",
    description: "A site that explains the product and converts.",
    measure: "Site live, 100 sign-ups in the first month.",
  },
  mike,
);
const site = await work.createProject(
  {
    companyId: company.id,
    name: "Website",
    description: "The public site and the pricing page.",
    goalId: goal.id,
  },
  mike,
);
const research = await work.createProject(
  {
    companyId: company.id,
    name: "Market research",
    description: "What the competitors do and charge.",
    goalId: goal.id,
  },
  mike,
);
const leo = (await app.inject({ method: "GET", url: `/v1/companies/${company.id}/agents` })).json() as Array<{ id: string; name: string }>;
const leoId = leo.find((a) => a.name === "Leo")!.id;

const pricing = await work.createTask(
  {
    companyId: company.id,
    projectId: site.id,
    title: "Write the pricing page",
    description: "Three plans, one clear recommendation, no jargon.",
    acceptance: "Copy approved by Mike; renders on mobile.",
    priority: "high",
    assigneeAgentId: leoId,
  },
  mike,
);
await work.checkout(company.id, pricing.id, { agentId: leoId });
const compare = await work.createTask(
  {
    companyId: company.id,
    projectId: research.id,
    title: "Compare competitor pricing",
    description: "Six closest competitors: plans, prices, limits.",
    acceptance: "A table with sources for every number.",
    priority: "normal",
    assigneeAgentId: nora.id,
  },
  mike,
);
await work.checkout(company.id, compare.id, { agentId: nora.id });
await work.addProduct(
  company.id,
  compare.id,
  {
    kind: "document",
    title: "competitor-pricing.md",
    ref: "docs/competitor-pricing.md",
    summary: "Six competitors compared, with sources.",
  },
  { kind: "agent", id: nora.id },
);
await work.requestReview(
  company.id,
  compare.id,
  {
    summary: "Compared six competitors; the median price is 29 EUR a month. Table with sources attached.",
    verification: "Every price checked on the public pricing page on 18 September.",
  },
  { kind: "agent", id: nora.id },
);
const analytics = await work.createTask(
  {
    companyId: company.id,
    projectId: site.id,
    title: "Set up analytics",
    description: "Privacy-friendly analytics on every page.",
    priority: "normal",
    assigneeAgentId: philip.id,
  },
  mike,
);
await work.checkout(company.id, analytics.id, { agentId: philip.id });
await work.block(company.id, analytics.id, "I need the analytics account credentials; none is configured.", { kind: "agent", id: philip.id });
const domain = await work.createTask(
  {
    companyId: company.id,
    projectId: site.id,
    title: "Choose the domain name",
    priority: "urgent",
    assigneeAgentId: philip.id,
  },
  mike,
);
await work.checkout(company.id, domain.id, { agentId: philip.id });
await work.complete(
  company.id,
  domain.id,
  {
    summary: "Registered nextepochs.ai; DNS points to the new host.",
    verification: "dig shows the new records; the site answers over HTTPS.",
  },
  { kind: "agent", id: philip.id },
);
await work.createTask(
  {
    companyId: company.id,
    projectId: site.id,
    title: "Design the home page",
    description: "Hero, three benefits, one call to action.",
    priority: "high",
    assigneeAgentId: leoId,
  },
  mike,
);
await work.createTask(
  {
    companyId: company.id,
    projectId: site.id,
    title: "Write the FAQ",
    priority: "low",
  },
  mike,
);
await work.createTask(
  {
    companyId: company.id,
    projectId: research.id,
    title: "Interview five customers",
    description: "What made them choose us, what almost stopped them.",
    priority: "normal",
    assigneeAgentId: nora.id,
  },
  mike,
);
await work.comment(company.id, pricing.id, mike, "Keep the middle plan as the recommended one.");
await work.comment(company.id, pricing.id, { kind: "agent", id: leoId }, "Understood — drafting three plans now, middle one highlighted.");

// Learning: memories, skills and a couple of reviews, so the Learning page has something to show.
const learning = app.opifer.learning!;
const noraActor = { kind: "agent" as const, id: nora.id };
await learning.memories.remember(
  {
    companyId: company.id,
    scope: "company",
    content: "The company writes everything in English; the interface stays bilingual.",
  },
  mike,
);
await learning.memories.remember(
  {
    companyId: company.id,
    scope: "agent",
    scopeAgentId: nora.id,
    kind: "profile",
    subject: "Mike",
    content: "Wants a source for every number and prefers tables to prose.",
    source: { taskId: compare.id },
  },
  noraActor,
);
await learning.memories.remember(
  {
    companyId: company.id,
    scope: "agent",
    scopeAgentId: nora.id,
    content: "Competitor pricing pages change on Mondays; check them early in the week.",
    source: { taskId: compare.id },
  },
  noraActor,
);
await learning.memories.remember(
  {
    companyId: company.id,
    scope: "agent",
    scopeAgentId: leoId,
    content: "The pricing page lives in site/pricing.md; keep three plans and highlight the middle one.",
  },
  { kind: "agent", id: leoId },
);
await learning.memories.remember(
  {
    companyId: company.id,
    scope: "team",
    scopeAgentId: philip.id,
    content: "Deploys happen on Fridays before noon.",
    pinned: true,
  },
  mike,
);
const compareSkill = await learning.skills.create(
  {
    companyId: company.id,
    scope: "agent",
    scopeAgentId: nora.id,
    name: "compare-pricing",
    description: "Compare the pricing pages of a list of competitors into a sourced table",
    content:
      "1. Open each competitor's public pricing page.\n2. Note plans, monthly and yearly prices, limits.\n3. Put everything in one table, one row per plan, with the URL as source.\n4. Add the median price at the bottom.\n5. Deliver with task_deliver and attach the table as a document.",
    origin: "agent",
    note: "learned by the background review",
  },
  noraActor,
);
await learning.skills.update(
  company.id,
  compareSkill.id,
  {
    content:
      "1. Open each competitor's public pricing page.\n2. Note plans, monthly and yearly prices, limits, and the date you checked.\n3. Put everything in one table, one row per plan, with the URL as source.\n4. Add the median price at the bottom.\n5. Deliver with task_deliver and attach the table as a document.",
    note: "add the date checked",
  },
  noraActor,
);
await learning.skills.recordUse(company.id, compareSkill.id, {
  agentId: nora.id,
  taskId: compare.id,
});
await learning.skills.create(
  {
    companyId: company.id,
    scope: "company",
    name: "write-release-notes",
    description: "Write the release notes of a version from the changelog",
    content: "1. Read CHANGELOG.md.\n2. One line per user-visible change, no internals.\n3. Group by Added / Changed / Fixed.\n4. Deliver as a document.",
    origin: "person",
    pinned: true,
  },
  mike,
);
await learning.skills.create(
  {
    companyId: company.id,
    scope: "agent",
    scopeAgentId: leoId,
    name: "old-landing-copy",
    description: "Copy for the previous landing page (retired layout)",
    content: "Old steps.",
    origin: "agent",
  },
  { kind: "agent", id: leoId },
);
await db.sql`UPDATE skills SET created_at = now() - interval '120 days' WHERE name = 'old-landing-copy'`;
await learning.skills.curate(company.id, {
  inactiveAfterDays: 30,
  archiveAfterDays: 90,
});
await db.sql`INSERT INTO learning_reviews (company_id, agent_id, session_id, task_id, status, proposals, applied, finished_at) VALUES
  (${company.id}, ${nora.id}, ${s2.id}, ${compare.id}, 'done', ${{ reason: "a repeatable comparison with a clear procedure" } as never}::jsonb, ${{ memoryIds: ["a", "b"], skill: { id: compareSkill.id, name: "compare-pricing", version: 1 } } as never}::jsonb, now()),
  (${company.id}, ${philip.id}, ${s1.id}, null, 'done', ${{ reason: "nothing new: the build already went fine" } as never}::jsonb, ${{ memoryIds: [] } as never}::jsonb, now())`;

await app.listen({ host: "127.0.0.1", port });
console.log(`preview on http://127.0.0.1:${port}  (company ${company.id})`);
