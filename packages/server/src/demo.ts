/**
 * The demo company: a small team, goals, projects, tasks in every state,
 * memories, skills, routines, a connection, a webhook, a subscription and a
 * channel — enough to walk through every screen. Used by the preview server
 * and by `o4r init --demo`; with `sessions: false` no model is ever called.
 */

import type { FastifyInstance } from "fastify";

export interface DemoOptions {
  name?: string;
  mission?: string;
  /** Start two conversations that call the model (only sensible with the scripted provider). */
  sessions?: boolean;
  /** Authenticated mode: the caller's cookie or bearer token, forwarded to the internal calls. */
  headers?: Record<string, string>;
}

export async function seedDemoCompany(app: FastifyInstance, options: DemoOptions = {}): Promise<{ companyId: string }> {
  const db = app.opifer.db;
  const company = (
    await app.inject({
      headers: options.headers ?? {},
      method: "POST",
      url: "/v1/companies",
      payload: {
        name: options.name ?? "Proclive",
        mission: options.mission ?? "AI-powered software for small companies",
      },
    })
  ).json() as { id: string };
  const philip = (
    await app.inject({
      headers: options.headers ?? {},
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
      headers: options.headers ?? {},
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
    headers: options.headers ?? {},
    method: "POST",
    url: `/v1/companies/${company.id}/agents`,
    payload: {
      name: "Leo",
      role: "Copywriter. Writes in Italian and English.",
      reportsToAgentId: philip.id,
    },
  });
  await app.inject({
    headers: options.headers ?? {},
    method: "PUT",
    url: `/v1/companies/${company.id}/budgets`,
    payload: { scopeKind: "company", cap: 50 },
  });
  await app.inject({
    headers: options.headers ?? {},
    method: "PUT",
    url: `/v1/companies/${company.id}/budgets`,
    payload: { scopeKind: "agent", scopeId: nora.id, cap: 5 },
  });

  let s1: { id: string } = { id: "" };
  let s2: { id: string } = { id: "" };
  if (options.sessions !== false) {
    s1 = (
      await app.inject({
        headers: options.headers ?? {},
        method: "POST",
        url: `/v1/companies/${company.id}/sessions`,
        payload: { agentId: philip.id, title: "Rebuild the website" },
      })
    ).json() as { id: string };
    await app.inject({
      headers: options.headers ?? {},
      method: "POST",
      url: `/v1/sessions/${s1.id}/messages`,
      payload: {
        text: "Rebuild the website with the new pricing page and make sure the build passes.",
      },
    });
    s2 = (
      await app.inject({
        headers: options.headers ?? {},
        method: "POST",
        url: `/v1/companies/${company.id}/sessions`,
        payload: { agentId: nora.id, title: "Competitor pricing" },
      })
    ).json() as { id: string };
    await app.inject({
      headers: options.headers ?? {},
      method: "POST",
      url: `/v1/sessions/${s2.id}/messages`,
      payload: {
        text: "Compare the pricing pages of our six closest competitors.",
      },
    });
  }

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
  const leo = (
    await app.inject({
      headers: options.headers ?? {},
      method: "GET",
      url: `/v1/companies/${company.id}/agents`,
    })
  ).json() as Array<{ id: string; name: string }>;
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
  if (s1.id && s2.id)
    await db.sql`INSERT INTO learning_reviews (company_id, agent_id, session_id, task_id, status, proposals, applied, finished_at) VALUES
    (${company.id}, ${nora.id}, ${s2.id || null}, ${compare.id}, 'done', ${{ reason: "a repeatable comparison with a clear procedure" } as never}::jsonb, ${{ memoryIds: ["a", "b"], skill: { id: compareSkill.id, name: "compare-pricing", version: 1 } } as never}::jsonb, now()),
    (${company.id}, ${philip.id}, ${s1.id || null}, null, 'done', ${{ reason: "nothing new: the build already went fine" } as never}::jsonb, ${{ memoryIds: [] } as never}::jsonb, now())`;

  // Connections: a routine for Sam, a workflow tool, a webhook and a subscription, a Telegram channel waiting for its secret.
  const sam = (
    await app.inject({
      headers: options.headers ?? {},
      method: "POST",
      url: `/v1/companies/${company.id}/agents`,
      payload: { name: "Sam", role: "Support and operations. Keeps checklists and routines running.", reportsToAgentId: philip.id },
    })
  ).json() as { id: string };
  await app.opifer.routines.create(
    {
      companyId: company.id,
      agentId: sam.id,
      name: "Weekly digest",
      prompt: "Produce the weekly digest of the repository: commits, tests, open tasks. Deliver it as a short note.",
      scheduleKind: "cron",
      schedule: "0 9 * * 1",
      timezone: "Europe/Rome",
      deliverTo: ["channels"],
      skills: [],
    },
    mike,
  );
  const daily = await app.opifer.routines.create(
    {
      companyId: company.id,
      agentId: sam.id,
      name: "Daily health check",
      prompt: "Check that the site answers and the build passes; report anything odd.",
      scheduleKind: "interval",
      schedule: "86400",
      deliverTo: ["channels"],
    },
    mike,
  );
  await db.sql`INSERT INTO routine_runs (company_id, routine_id, due_at, status, result, started_at, finished_at) VALUES (${company.id}, ${daily.id}, now() - interval '1 day', 'done', 'All green: the site answers in 120 ms and the build passes.', now() - interval '1 day', now() - interval '1 day' + interval '40 seconds')`;
  await app.opifer.connections.create(
    {
      companyId: company.id,
      kind: "workflow",
      name: "n8n_report",
      description: "Sends the weekly numbers to the reporting workflow in n8n",
      config: {
        url: "http://127.0.0.1:5678/webhook/report",
        method: "POST",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        headers: { authorization: "Bearer ${N8N_TOKEN}" },
      },
      risk: "medium",
      secretNames: ["N8N_TOKEN"],
    },
    mike,
  );
  await app.opifer.webhooks.create({ companyId: company.id, name: "n8n-tasks", action: "create_task", defaults: { agentId: philip.id } }, mike);
  await app.opifer.events.create({ companyId: company.id, name: "n8n-listener", url: "http://127.0.0.1:5678/webhook/opifer", events: ["task.*", "approval.*"] }, mike);
  await app.opifer.channels.create({ companyId: company.id, kind: "telegram", name: "Telegram", secretName: "TELEGRAM_BOT_TOKEN", defaultAgentId: philip.id }, mike);
  await db.sql`UPDATE channels SET status = 'missing_secret', status_detail = 'set the secret TELEGRAM_BOT_TOKEN' WHERE company_id = ${company.id}`;
  return { companyId: company.id };
}
