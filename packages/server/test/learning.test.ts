import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { REVIEW_PROMPT } from "@opifer/learning";
import { ProviderRegistry } from "@opifer/runtime";
import { FakeProvider } from "@opifer/runtime/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

/**
 * The M4 acceptance: a job done once is reviewed in the background, the
 * review saves a skill, and the same job done again uses the skill and
 * costs at least 25% less. The live session of the first job is untouched.
 */
describe("Learning: background review, skills in the prompt, cheaper repeats", () => {
  let db: TestDatabase;
  let app: FastifyInstance;
  let companyId: string;
  let philip: string;
  let workdir: string;
  const reviewCalls: string[] = [];

  const runScheduler = async () => {
    const scheduler = app.opifer.scheduler!;
    for (let i = 0; i < 6; i++) {
      await scheduler.tick();
      await scheduler.drain();
    }
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    const dir = await mkdtemp(path.join(tmpdir(), "opifer-learning-"));
    workdir = path.join(dir, "site");
    await mkdir(workdir, { recursive: true });
    await writeFile(path.join(workdir, "README.md"), "# Site\nBuild with: pnpm build\n");
    await writeFile(path.join(workdir, "CHANGELOG.md"), "## 1.0\n- first\n");

    const provider = new FakeProvider((request) => {
      // The reviewer: proposes the procedure as a skill, plus a memory.
      if (request.system === REVIEW_PROMPT) {
        reviewCalls.push(request.messages[0]!.content.map((p) => (p.type === "text" ? p.text : "")).join(""));
        return {
          kind: "text",
          text: JSON.stringify({
            memories: [
              {
                kind: "note",
                content: "The site builds with pnpm build; the README says so.",
              },
            ],
            skill: {
              name: "release-notes",
              description: "Write the release notes of the site from its changelog",
              content: "1. Read CHANGELOG.md.\n2. Write the notes.\n3. Deliver with task_deliver.",
            },
            retire: [],
            reason: "repeatable",
          }),
        };
      }
      const last = request.messages.at(-1)!;
      const results = request.messages.flatMap((m) => m.content.filter((p) => p.type === "tool_result"));
      const step = results.length;
      const knowsSkill = request.system.includes("- release-notes:");
      const text = last.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      const deliver = {
        kind: "tools" as const,
        calls: [
          {
            name: "task_deliver",
            arguments: {
              summary: "Release notes written from the changelog",
              verification: "notes match CHANGELOG.md",
            },
          },
        ],
      };
      if (text.startsWith("You have been assigned"))
        return {
          kind: "tools",
          calls: [{ name: "task_status", arguments: {} }],
        };
      if (knowsSkill) {
        // With the skill: load it, read the changelog, deliver.
        if (step === 1)
          return {
            kind: "tools",
            calls: [{ name: "skill_load", arguments: { name: "release-notes" } }],
          };
        if (step === 2)
          return {
            kind: "tools",
            calls: [{ name: "read_file", arguments: { path: "CHANGELOG.md" } }],
          };
        return deliver;
      }
      // Without it: explore the folder, read the wrong file first, search, then read the right one.
      if (step === 1)
        return {
          kind: "tools",
          calls: [{ name: "list_files", arguments: { path: "." } }],
        };
      if (step === 2)
        return {
          kind: "tools",
          calls: [{ name: "read_file", arguments: { path: "README.md" } }],
        };
      if (step === 3)
        return {
          kind: "tools",
          calls: [{ name: "search_files", arguments: { pattern: "1.0", path: "." } }],
        };
      if (step === 4)
        return {
          kind: "tools",
          calls: [{ name: "read_file", arguments: { path: "CHANGELOG.md" } }],
        };
      if (step === 5)
        return {
          kind: "tools",
          calls: [
            {
              name: "memory_save",
              arguments: { content: "Release notes come from CHANGELOG.md." },
            },
          ],
        };
      return deliver;
    });
    app = await buildApp({
      db,
      connections: { start: false, sandbox: "local" },
      mode: "local",
      providers: {
        providers: new ProviderRegistry().register(provider),
        defaultModel: "fake/echo",
        fallbackModel: null,
        report: [],
      },
      workRoot: path.join(dir, "work"),
      governance: { credentialsDir: path.join(dir, "credentials") },
      work: { scheduler: false, leaseMs: 60_000 },
      learning: { worker: false },
    });
    app.opifer.governance!.prices.set("fake/echo", {
      inputPerMillion: 3,
      outputPerMillion: 15,
      currency: "USD",
    });
    await app.ready();
    companyId = (
      (
        await app.inject({
          method: "POST",
          url: "/v1/companies",
          payload: { name: "Learn Co", mission: "Ship useful software" },
        })
      ).json() as { id: string }
    ).id;
    philip = (
      (
        await app.inject({
          method: "POST",
          url: `/v1/companies/${companyId}/agents`,
          payload: { name: "Philip", role: "CEO" },
        })
      ).json() as { id: string }
    ).id;
    await app.inject({
      method: "POST",
      url: `/v1/companies/${companyId}/projects`,
      payload: { name: "Site", workdir },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  const costOf = async (taskId: string) => {
    const [row] = await db.sql<
      { eur: string; calls: string }[]
    >`SELECT coalesce(sum(amount_eur), 0)::text AS eur, count(*)::text AS calls FROM cost_events WHERE task_id = ${taskId} AND kind = 'model'`;
    return { eur: Number(row!.eur), calls: Number(row!.calls) };
  };

  const doTask = async (title: string) => {
    const project = (
      (
        await app.inject({
          method: "GET",
          url: `/v1/companies/${companyId}/projects`,
        })
      ).json() as Array<{ id: string }>
    )[0]!;
    const task = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/tasks`,
        payload: {
          title,
          description: "Write the release notes from the changelog.",
          assigneeAgentId: philip,
          projectId: project.id,
        },
      })
    ).json() as { id: string };
    await runScheduler();
    const delivered = (await app.inject({ method: "GET", url: `/v1/tasks/${task.id}` })).json() as { status: string; sessionId?: string | null };
    expect(delivered.status).toBe("in_review");
    const done = (
      await app.inject({
        method: "POST",
        url: `/v1/tasks/${task.id}/complete`,
        payload: {
          summary: "Verified by Mike",
          verification: "read the notes",
        },
      })
    ).json() as { status: string };
    expect(done.status).toBe("done");
    return task.id;
  };

  it("the first job is reviewed outside the turn, the review saves a skill and a memory, and the live session stays untouched", async () => {
    const first = await doTask("Release notes 1.0");
    const before = await costOf(first);
    expect(before.calls).toBeGreaterThanOrEqual(6);

    const sessions = (
      await app.inject({
        method: "GET",
        url: `/v1/companies/${companyId}/sessions`,
      })
    ).json() as Array<{
      id: string;
      taskId: string | null;
      systemPromptHash: string;
    }>;
    const session = sessions.find((s) => s.taskId === first)!;
    const messagesBefore = JSON.stringify(
      (
        await app.inject({
          method: "GET",
          url: `/v1/sessions/${session.id}/messages`,
        })
      ).json(),
    );
    expect(session).toBeDefined();
    // The memory the agent saved mid-turn is in the store, not in the prompt of this session.
    const own = (
      await app.inject({
        method: "GET",
        url: `/v1/companies/${companyId}/memories?agent=${philip}`,
      })
    ).json() as Array<{ content: string; authorKind: string }>;
    expect(own.some((m) => m.content.includes("CHANGELOG.md"))).toBe(true);

    const pending = (
      await app.inject({
        method: "GET",
        url: `/v1/companies/${companyId}/learning/reviews`,
      })
    ).json() as Array<{ status: string; taskId: string | null }>;
    expect(pending.some((r) => r.status === "pending" && r.taskId === first)).toBe(true);
    const ran = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/learning/reviews/run`,
      })
    ).json() as { done: number };
    expect(ran.done).toBeGreaterThanOrEqual(1);
    expect(reviewCalls[0]).toContain("The conversation:");
    expect(reviewCalls[0]).toContain("AGENT calls task_deliver");

    const reviews = (
      await app.inject({
        method: "GET",
        url: `/v1/companies/${companyId}/learning/reviews`,
      })
    ).json() as Array<{
      status: string;
      applied: { skill?: { name: string } | null; memoryIds?: string[] };
    }>;
    const done = reviews.find((r) => r.status === "done")!;
    expect(done.applied.skill?.name).toBe("release-notes");
    expect(done.applied.memoryIds).toHaveLength(1);

    const messagesAfter = JSON.stringify(
      (
        await app.inject({
          method: "GET",
          url: `/v1/sessions/${session.id}/messages`,
        })
      ).json(),
    );
    expect(messagesAfter).toBe(messagesBefore);
    const again = (
      (
        await app.inject({
          method: "GET",
          url: `/v1/companies/${companyId}/sessions`,
        })
      ).json() as Array<{ id: string; systemPromptHash: string }>
    ).find((s) => s.id === session.id)!;
    expect(again.systemPromptHash).toBe(session.systemPromptHash);

    const snapshot = (
      await app.inject({
        method: "GET",
        url: `/v1/companies/${companyId}/agents/${philip}/learning-snapshot`,
      })
    ).json() as { memory: string; skills: Array<{ name: string }> };
    expect(snapshot.skills.map((s) => s.name)).toEqual(["release-notes"]);
    expect(snapshot.memory).toContain("pnpm build");
  });

  it("the repeated job uses the learned skill and costs at least 25% less", async () => {
    const [firstTask] = await db.sql<{ id: string }[]>`SELECT id FROM tasks WHERE company_id = ${companyId} ORDER BY created_at LIMIT 1`;
    const before = await costOf(firstTask!.id);
    const second = await doTask("Release notes 1.1");
    const after = await costOf(second);
    expect(before.eur).toBeGreaterThan(0);
    expect(after.calls).toBeLessThan(before.calls);
    expect(after.eur).toBeLessThanOrEqual(before.eur * 0.75);
    console.log(
      `cost without the skill: ${before.eur.toFixed(6)} EUR in ${before.calls} calls; with it: ${after.eur.toFixed(6)} EUR in ${after.calls} calls (${Math.round((1 - after.eur / before.eur) * 100)}% less)`,
    );

    const skills = (
      await app.inject({
        method: "GET",
        url: `/v1/companies/${companyId}/skills?agent=${philip}`,
      })
    ).json() as Array<{ id: string; name: string; uses: number }>;
    const skill = skills.find((s) => s.name === "release-notes")!;
    expect(skill.uses).toBe(1);
    const detail = (
      await app.inject({
        method: "GET",
        url: `/v1/companies/${companyId}/skills/${skill.id}`,
      })
    ).json() as { usage: { successes: number }; version: { content: string } };
    expect(detail.usage.successes).toBe(1);
    expect(detail.version.content).toContain("CHANGELOG.md");
    const sessions = (
      await app.inject({
        method: "GET",
        url: `/v1/companies/${companyId}/sessions`,
      })
    ).json() as Array<{ taskId: string | null; systemPrompt?: string }>;
    expect(sessions.find((s) => s.taskId === second)).toBeDefined();
  });

  it("a person promotes the skill to the company through the inbox", async () => {
    const skills = (
      await app.inject({
        method: "GET",
        url: `/v1/companies/${companyId}/skills?scope=agent&scopeAgentId=${philip}`,
      })
    ).json() as Array<{ id: string; name: string }>;
    const skill = skills.find((s) => s.name === "release-notes")!;
    const proposed = (
      await app.inject({
        method: "POST",
        url: `/v1/companies/${companyId}/skills/${skill.id}/promote`,
        payload: { toScope: "company" },
      })
    ).json() as { id: string; status: string; approvalId: string | null };
    expect(proposed.status).toBe("proposed");
    const inbox = (
      await app.inject({
        method: "GET",
        url: `/v1/companies/${companyId}/approvals?status=pending`,
      })
    ).json() as Array<{ id: string; kind: string; subject: { name?: string } }>;
    const approval = inbox.find((a) => a.kind === "skill_promotion")!;
    expect(approval.subject.name).toBe("release-notes");
    const decided = (
      await app.inject({
        method: "POST",
        url: `/v1/approvals/${approval.id}/decide`,
        payload: { status: "approved" },
      })
    ).json() as { followUp?: string };
    expect(decided.followUp).toBe("promotion_applied");
    const shared = (
      await app.inject({
        method: "GET",
        url: `/v1/companies/${companyId}/skills?scope=company`,
      })
    ).json() as Array<{ name: string; promotedFromId: string | null }>;
    expect(shared.find((s) => s.name === "release-notes")?.promotedFromId).toBe(skill.id);
    const exported = (
      await app.inject({
        method: "GET",
        url: `/v1/companies/${companyId}/skills/${skill.id}/export`,
      })
    ).json() as { markdown: string };
    expect(exported.markdown.startsWith("---\nname: release-notes\n")).toBe(true);
  });
});
