import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { ApprovalService } from "@opifer/gateway";
import { ProviderRegistry, SessionStore } from "@opifer/runtime";
import { FakeProvider } from "@opifer/runtime/testing";
import type { Embedder } from "@opifer/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LearningError, LearningService, parseSkillMarkdown, renderSkillMarkdown, transcriptOf, parseProposals } from "../src/index.js";

interface Fixture {
  db: TestDatabase;
  learning: LearningService;
  store: SessionStore;
  companyId: string;
  ceo: string;
  nora: string;
  leo: string;
  approvals: ApprovalService;
}

/** A toy embedder: bag of letters, enough to tell "pricing" from "kittens". */
const toyEmbedder: Embedder = {
  id: "toy/letters",
  dimensions: 26,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array<number>(26).fill(0);
      for (const ch of t.toLowerCase()) {
        const i = ch.charCodeAt(0) - 97;
        if (i >= 0 && i < 26) v[i]!++;
      }
      return v;
    });
  },
};

async function createFixture(
  options: {
    embedder?: Embedder | null;
    reviewScript?: (text: string) => string;
  } = {},
): Promise<Fixture> {
  const db = await createTestDatabase();
  const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name, mission) VALUES ('Workshop', 'Ship useful software') RETURNING id`;
  const [ceo] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name, role) VALUES (${company!.id}, 'Philip', 'CEO') RETURNING id`;
  const [nora] = await db.sql<
    { id: string }[]
  >`INSERT INTO agents (company_id, name, role, reports_to_agent_id) VALUES (${company!.id}, 'Nora', 'Researcher', ${ceo!.id}) RETURNING id`;
  const [leo] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name, role, reports_to_agent_id) VALUES (${company!.id}, 'Leo', 'Writer', ${ceo!.id}) RETURNING id`;
  const provider = new FakeProvider((request) => {
    const text = request.messages.map((m) => m.content.map((p) => (p.type === "text" ? p.text : "")).join("")).join("\n");
    return {
      kind: "text",
      text: options.reviewScript ? options.reviewScript(text) : '{"memories":[],"skill":null,"retire":[],"reason":"nothing"}',
    };
  });
  const providers = new ProviderRegistry().register(provider);
  const store = new SessionStore(db.sql);
  const approvals = new ApprovalService(db.sql);
  const learning = new LearningService(db.sql, store, providers, {
    embedder: options.embedder ?? null,
    approvals,
  });
  return {
    db,
    learning,
    store,
    companyId: company!.id,
    ceo: ceo!.id,
    nora: nora!.id,
    leo: leo!.id,
    approvals,
  };
}

describe("memory: scopes, snapshot, corrections, search", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture({ embedder: toyEmbedder });
  }, 120_000);
  afterAll(async () => f?.db.destroy());

  it("an agent reads its own entries, its managers' team entries and the company's; not a colleague's", async () => {
    const { memories } = f.learning;
    const person = { kind: "person" as const };
    await memories.remember(
      {
        companyId: f.companyId,
        scope: "agent",
        scopeAgentId: f.nora,
        content: "Mike prefers tables with sources for every number.",
      },
      person,
    );
    await memories.remember(
      {
        companyId: f.companyId,
        scope: "agent",
        scopeAgentId: f.leo,
        content: "Leo's private note about copy tone.",
      },
      person,
    );
    await memories.remember(
      {
        companyId: f.companyId,
        scope: "team",
        scopeAgentId: f.ceo,
        content: "The team ships on Fridays.",
      },
      person,
    );
    await memories.remember(
      {
        companyId: f.companyId,
        scope: "company",
        content: "The company writes in English.",
        kind: "note",
      },
      person,
    );
    const seen = (await memories.list(f.companyId, { agentView: f.nora })).map((m) => m.content);
    expect(seen).toContain("Mike prefers tables with sources for every number.");
    expect(seen).toContain("The team ships on Fridays.");
    expect(seen).toContain("The company writes in English.");
    expect(seen).not.toContain("Leo's private note about copy tone.");
    const snapshot = await f.learning.snapshot(f.companyId, f.nora);
    expect(snapshot.memory).toContain("- Mike prefers tables");
    expect(snapshot.memory).toContain("[team] The team ships on Fridays.");
    expect(snapshot.memory).toContain("[company] The company writes in English.");
    expect(snapshot.memoryCount).toBe(3);
  });

  it("the snapshot respects the size cap and says how much is left out", async () => {
    for (let i = 0; i < 30; i++)
      await f.learning.memories.remember(
        {
          companyId: f.companyId,
          scope: "agent",
          scopeAgentId: f.leo,
          content: `Note number ${i} about something Leo learned while writing.`,
        },
        { kind: "agent", id: f.leo },
      );
    await f.learning.settings.update(f.companyId, { snapshotMaxChars: 400 }, { kind: "person" });
    const snapshot = await f.learning.snapshot(f.companyId, f.leo);
    expect(snapshot.memory.length).toBeLessThan(500);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.memory).toContain("more entries: use memory_search");
    await f.learning.settings.update(f.companyId, { snapshotMaxChars: 6000 }, { kind: "person" });
  });

  it("a correction supersedes, a retirement keeps the entry; neither deletes", async () => {
    const { memories } = f.learning;
    const m = await memories.remember(
      {
        companyId: f.companyId,
        scope: "agent",
        scopeAgentId: f.nora,
        content: "The pricing page has four plans.",
      },
      { kind: "agent", id: f.nora },
    );
    const fixed = await memories.correct(f.companyId, m.id, "The pricing page has three plans.", { kind: "person" });
    expect(fixed.supersedesId).toBe(m.id);
    expect((await memories.get(f.companyId, m.id))?.status).toBe("superseded");
    await expect(memories.retire(f.companyId, fixed.id, "", { kind: "person" })).rejects.toBeInstanceOf(LearningError);
    const retired = await memories.retire(f.companyId, fixed.id, "the page changed again", { kind: "person" });
    expect(retired.status).toBe("retired");
    expect(retired.retiredReason).toBe("the page changed again");
    const active = await memories.list(f.companyId, { agentView: f.nora });
    expect(active.some((x) => x.id === m.id || x.id === fixed.id)).toBe(false);
    const all = await memories.list(f.companyId, {
      agentView: f.nora,
      status: ["active", "retired", "superseded"],
    });
    expect(all.some((x) => x.id === m.id)).toBe(true);
    const [row] = await f.db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_log WHERE action IN ('memory.corrected', 'memory.retired')`;
    expect(Number(row!.n)).toBe(2);
  });

  it("search finds by words and reranks by meaning when an embedder is on", async () => {
    const hits = await f.learning.memories.search(f.companyId, f.nora, "tables with sources");
    expect(hits[0]?.memory.content).toContain("tables with sources");
    expect(f.learning.memories.semantic).toBe(true);
    expect(hits[0]!.memory.hasEmbedding).toBe(true);
    expect(await f.learning.memories.search(f.companyId, f.nora, "zzzz qqqq")).toEqual([]);
  });
});

describe("skills: versions, index, curator, promotion", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture();
  }, 120_000);
  afterAll(async () => f?.db.destroy());

  it("every change is a version and restoring is a new version", async () => {
    const { skills } = f.learning;
    const skill = await skills.create(
      {
        companyId: f.companyId,
        scope: "agent",
        scopeAgentId: f.nora,
        name: "compare-pricing",
        description: "Compare competitor pricing pages",
        content: "1. Open each page.\n2. Note plans and prices.",
        origin: "agent",
      },
      { kind: "agent", id: f.nora },
    );
    expect(skill.currentVersion).toBe(1);
    await expect(
      skills.create(
        {
          companyId: f.companyId,
          scope: "agent",
          scopeAgentId: f.nora,
          name: "compare-pricing",
          description: "again",
          content: "x",
          origin: "agent",
        },
        { kind: "agent", id: f.nora },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      skills.create(
        {
          companyId: f.companyId,
          scope: "agent",
          scopeAgentId: f.nora,
          name: "Bad Name!",
          description: "x",
          content: "x",
          origin: "agent",
        },
        { kind: "agent", id: f.nora },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const v2 = await skills.update(
      f.companyId,
      skill.id,
      {
        content: "1. Open each page.\n2. Note plans, prices and limits.\n3. Cite the source.",
        note: "add sources",
      },
      { kind: "person" },
    );
    expect(v2.version.version).toBe(2);
    const restored = await skills.restore(f.companyId, skill.id, 1, {
      kind: "person",
    });
    expect(restored.version.version).toBe(3);
    expect(restored.version.content).toContain("Note plans and prices.");
    expect((await skills.versions(f.companyId, skill.id)).map((v) => v.version)).toEqual([3, 2, 1]);
    const md = renderSkillMarkdown(restored.skill, restored.version);
    expect(parseSkillMarkdown(md)).toMatchObject({
      name: "compare-pricing",
      description: "Compare competitor pricing pages",
    });
  });

  it("the index shows what the agent can load, closer scopes first; loading counts a use", async () => {
    const { skills } = f.learning;
    await skills.create(
      {
        companyId: f.companyId,
        scope: "company",
        name: "write-release-notes",
        description: "Write release notes from the changelog",
        content: "steps",
        origin: "person",
      },
      { kind: "person" },
    );
    await skills.create(
      {
        companyId: f.companyId,
        scope: "company",
        name: "compare-pricing",
        description: "Company-wide version",
        content: "steps",
        origin: "person",
      },
      { kind: "person" },
    );
    const index = await skills.index(f.companyId, f.nora);
    expect(index.map((s) => s.name)).toEqual(["compare-pricing", "write-release-notes"]);
    expect(index.find((s) => s.name === "compare-pricing")?.description).toBe("Compare competitor pricing pages");
    const leoIndex = await skills.index(f.companyId, f.leo);
    expect(leoIndex.find((s) => s.name === "compare-pricing")?.description).toBe("Company-wide version");
    const own = await skills.resolve(f.companyId, f.nora, "compare-pricing");
    await skills.recordUse(f.companyId, own!.id, { agentId: f.nora });
    expect((await skills.get(f.companyId, own!.id))?.uses).toBe(1);
  });

  it("never delete what was learned: the curator archives unused agent skills, keeps pinned and person-made ones, and archives are restorable", async () => {
    const { skills } = f.learning;
    const old = new Date(Date.now() - 100 * 86_400_000);
    const stale = await skills.create(
      {
        companyId: f.companyId,
        scope: "agent",
        scopeAgentId: f.leo,
        name: "old-trick",
        description: "unused",
        content: "steps",
        origin: "agent",
      },
      { kind: "agent", id: f.leo },
    );
    const pinned = await skills.create(
      {
        companyId: f.companyId,
        scope: "agent",
        scopeAgentId: f.leo,
        name: "pinned-trick",
        description: "pinned",
        content: "steps",
        origin: "agent",
        pinned: true,
      },
      { kind: "agent", id: f.leo },
    );
    const human = await skills.create(
      {
        companyId: f.companyId,
        scope: "agent",
        scopeAgentId: f.leo,
        name: "human-trick",
        description: "by a person",
        content: "steps",
        origin: "person",
      },
      { kind: "person" },
    );
    const dozing = await skills.create(
      {
        companyId: f.companyId,
        scope: "agent",
        scopeAgentId: f.leo,
        name: "dozing-trick",
        description: "45 days idle",
        content: "steps",
        origin: "agent",
      },
      { kind: "agent", id: f.leo },
    );
    await f.db.sql`UPDATE skills SET created_at = ${old}, last_used_at = ${old} WHERE id IN (${stale.id}, ${pinned.id}, ${human.id})`;
    await f.db.sql`UPDATE skills SET created_at = ${new Date(Date.now() - 45 * 86_400_000)} WHERE id = ${dozing.id}`;
    const result = await skills.curate(f.companyId, {
      inactiveAfterDays: 30,
      archiveAfterDays: 90,
    });
    expect(result.archived).toEqual([stale.id]);
    expect(result.inactivated).toEqual([dozing.id]);
    expect((await skills.get(f.companyId, pinned.id))?.status).toBe("active");
    expect((await skills.get(f.companyId, human.id))?.status).toBe("active");
    const [backup] = await f.db.sql<{ payload: { skills: unknown[] } }[]>`SELECT payload FROM learning_backups WHERE id = ${result.backupId}`;
    expect(backup!.payload.skills.length).toBeGreaterThanOrEqual(4);
    const [count] = await f.db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM skills WHERE id = ${stale.id}`;
    expect(Number(count!.n)).toBe(1);
    const back = await skills.setStatus(f.companyId, stale.id, "active", {
      kind: "person",
    });
    expect(back.status).toBe("active");
    expect((await skills.versions(f.companyId, stale.id)).length).toBe(1);
  });

  it("knowledge rises a level only with governance: forbidden, review, automatic", async () => {
    const { skills, promotions, settings } = f.learning;
    const person = { kind: "person" as const };
    const skill = await skills.create(
      {
        companyId: f.companyId,
        scope: "agent",
        scopeAgentId: f.nora,
        name: "cite-sources",
        description: "Cite a source for every number",
        content: "steps",
        origin: "agent",
      },
      { kind: "agent", id: f.nora },
    );

    await settings.update(f.companyId, { promotion: "forbidden" }, person);
    await expect(promotions.propose(f.companyId, "skill", skill.id, "company", person)).rejects.toMatchObject({ code: "forbidden" });
    expect((await skills.list(f.companyId, { scope: "company" })).some((s) => s.name === "cite-sources")).toBe(false);

    await settings.update(f.companyId, { promotion: "review" }, person);
    const proposed = await promotions.propose(f.companyId, "skill", skill.id, "company", person, { successes: 3 });
    expect(proposed.status).toBe("proposed");
    expect(proposed.approvalId).not.toBeNull();
    expect((await skills.list(f.companyId, { scope: "company" })).some((s) => s.name === "cite-sources")).toBe(false);
    const approval = await f.approvals.get(f.companyId, proposed.approvalId!);
    expect(approval?.kind).toBe("skill_promotion");
    await f.approvals.decide(f.companyId, proposed.approvalId!, {
      status: "approved",
    });
    const applied = await promotions.decide(f.companyId, proposed.id, true, person);
    expect(applied.status).toBe("applied");
    const shared = (await skills.list(f.companyId, { scope: "company" })).find((s) => s.name === "cite-sources");
    expect(shared?.promotedFromId).toBe(skill.id);
    expect((await skills.index(f.companyId, f.leo)).some((s) => s.name === "cite-sources")).toBe(true);
    expect((await skills.get(f.companyId, skill.id))?.scope).toBe("agent");

    await settings.update(f.companyId, { promotion: "automatic" }, person);
    const memory = await f.learning.memories.remember(
      {
        companyId: f.companyId,
        scope: "agent",
        scopeAgentId: f.nora,
        content: "Public pricing pages change on Mondays.",
      },
      person,
    );
    const auto = await promotions.propose(f.companyId, "memory", memory.id, "company", person);
    expect(auto.status).toBe("applied");
    expect((await f.learning.memories.list(f.companyId, { scope: "company" })).some((m) => m.content.includes("Mondays"))).toBe(true);

    // A name clash at the target is flagged, never merged.
    const clash = await skills.create(
      {
        companyId: f.companyId,
        scope: "agent",
        scopeAgentId: f.leo,
        name: "cite-sources",
        description: "Leo's own",
        content: "other steps",
        origin: "agent",
      },
      { kind: "agent", id: f.leo },
    );
    await expect(promotions.propose(f.companyId, "skill", clash.id, "company", person)).rejects.toMatchObject({ code: "conflict" });
  });

  it("successful uses past the threshold propose a promotion by themselves", async () => {
    const { skills, promotions, settings } = f.learning;
    await settings.update(f.companyId, { promotion: "review", promotionThreshold: 2 }, { kind: "person" });
    const skill = await skills.create(
      {
        companyId: f.companyId,
        scope: "agent",
        scopeAgentId: f.leo,
        name: "draft-faq",
        description: "Draft an FAQ",
        content: "steps",
        origin: "agent",
      },
      { kind: "agent", id: f.leo },
    );
    const [t1] = await f.db.sql<{ id: string }[]>`INSERT INTO tasks (company_id, title, status) VALUES (${f.companyId}, 'FAQ one', 'in_progress') RETURNING id`;
    const [t2] = await f.db.sql<{ id: string }[]>`INSERT INTO tasks (company_id, title, status) VALUES (${f.companyId}, 'FAQ two', 'in_progress') RETURNING id`;
    await skills.recordUse(f.companyId, skill.id, {
      agentId: f.leo,
      taskId: t1!.id,
    });
    await f.learning.onTaskClosed(f.companyId, t1!.id, "success");
    expect((await promotions.list(f.companyId)).some((p) => p.subjectId === skill.id)).toBe(false);
    await skills.recordUse(f.companyId, skill.id, {
      agentId: f.leo,
      taskId: t2!.id,
    });
    await f.learning.onTaskClosed(f.companyId, t2!.id, "success");
    const proposal = (await promotions.list(f.companyId)).find((p) => p.subjectId === skill.id);
    expect(proposal?.status).toBe("proposed");
    expect(proposal?.evidence).toMatchObject({ successes: 2 });
  });
});

describe("the background review", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await createFixture({
      reviewScript: (text) =>
        (text.split("The conversation:")[1] ?? "").includes("pricing page")
          ? JSON.stringify({
              memories: [
                {
                  kind: "profile",
                  subject: "Mike",
                  content: "Wants the middle plan highlighted.",
                },
                {
                  kind: "note",
                  content: "Pricing pages live in site/pricing.md.",
                },
              ],
              skill: {
                name: "write-pricing-page",
                description: "Write or update the pricing page",
                content: "1. Read site/pricing.md.\n2. Keep three plans.\n3. Highlight the middle one.\n4. Run pnpm build.",
              },
              retire: [],
              reason: "a repeatable job",
            })
          : '{"memories":[],"skill":null,"retire":[],"reason":"small talk"}',
    });
  }, 120_000);
  afterAll(async () => f?.db.destroy());

  it("learns outside the turn: the live session is untouched and the knowledge lands in the store", async () => {
    const session = await f.store.createSession({
      companyId: f.companyId,
      agentId: f.leo,
      kind: "chat",
      title: null,
      systemPrompt: "SYSTEM PROMPT v1",
      systemPromptHash: "abc",
      model: "fake/echo",
      fallbackModel: null,
      workdir: null,
      taskId: null,
    });
    const run = await f.store.createRun({
      id: session.id,
      companyId: f.companyId,
      agentId: f.leo,
    });
    await f.store.appendMessage(
      session,
      "user",
      [
        {
          type: "text",
          text: "Please rewrite the pricing page: three plans, highlight the middle one, then build.",
        },
      ],
      { runId: run.id },
    );
    await f.store.appendMessage(
      session,
      "assistant",
      [
        {
          type: "tool_call",
          id: "c1",
          name: "terminal",
          arguments: { command: "pnpm build" },
        },
      ],
      { runId: run.id },
    );
    await f.store.appendMessage(
      session,
      "tool",
      [
        {
          type: "tool_result",
          toolCallId: "c1",
          content: "built",
          isError: false,
        },
      ],
      { runId: run.id },
    );
    await f.store.appendMessage(
      session,
      "assistant",
      [
        {
          type: "text",
          text: "Done: pricing page rewritten in site/pricing.md and the build passes.",
        },
      ],
      { runId: run.id },
    );
    await f.store.finishRun(run.id, {
      status: "completed",
      stopReason: "final_answer",
    });
    const before = {
      messages: await f.store.listMessages(session.id),
      session: await f.store.getSession(session.id),
    };

    const queued = await f.learning.reviewer.enqueue({
      companyId: f.companyId,
      agentId: f.leo,
      sessionId: session.id,
      runId: run.id,
    });
    expect(queued?.status).toBe("pending");
    const claimed = await f.learning.reviewer.claim();
    expect(claimed?.id).toBe(queued!.id);
    const done = await f.learning.reviewer.run(claimed!);
    expect(done.status).toBe("done");
    expect(done.applied.memoryIds).toHaveLength(2);
    expect(done.applied.skill?.name).toBe("write-pricing-page");

    const after = {
      messages: await f.store.listMessages(session.id),
      session: await f.store.getSession(session.id),
    };
    expect(after.messages).toEqual(before.messages);
    expect(after.session?.systemPrompt).toBe("SYSTEM PROMPT v1");
    expect(after.session?.systemPromptHash).toBe(before.session?.systemPromptHash);
    expect((await f.store.listRuns(session.id)).length).toBe(1);

    const snapshot = await f.learning.snapshot(f.companyId, f.leo);
    expect(snapshot.memory).toContain("Mike: Wants the middle plan highlighted.");
    expect(snapshot.skills).toEqual([
      {
        name: "write-pricing-page",
        description: "Write or update the pricing page",
      },
    ]);
    const memory = (await f.learning.memories.list(f.companyId, { agentView: f.leo }))[0];
    expect(memory?.sourceSessionId).toBe(session.id);
    expect(memory?.authorKind).toBe("agent");
    expect(await f.learning.reviewer.claim()).toBeNull();
  });

  it("a second review improves the skill instead of duplicating it, and small talk saves nothing", async () => {
    const session = await f.store.createSession({
      companyId: f.companyId,
      agentId: f.leo,
      kind: "chat",
      title: null,
      systemPrompt: "S",
      systemPromptHash: "h",
      model: "fake/echo",
      fallbackModel: null,
      workdir: null,
      taskId: null,
    });
    await f.store.appendMessage(session, "user", [
      {
        type: "text",
        text: "Update the pricing page again, same rules as before, and this time also check it on mobile.",
      },
    ]);
    await f.store.appendMessage(session, "assistant", [
      {
        type: "text",
        text: "Done, pricing page updated and checked on mobile.",
      },
    ]);
    const review = await f.learning.reviewer.run(
      (await f.learning.reviewer.enqueue({
        companyId: f.companyId,
        agentId: f.leo,
        sessionId: session.id,
      }))!,
    );
    expect(review.status).toBe("done");
    expect(review.applied.skill?.version).toBe(2);
    expect((await f.learning.skills.list(f.companyId, { agentView: f.leo })).filter((s) => s.name === "write-pricing-page")).toHaveLength(1);

    const chat = await f.store.createSession({
      companyId: f.companyId,
      agentId: f.leo,
      kind: "chat",
      title: null,
      systemPrompt: "S",
      systemPromptHash: "h",
      model: "fake/echo",
      fallbackModel: null,
      workdir: null,
      taskId: null,
    });
    await f.store.appendMessage(chat, "user", [
      {
        type: "text",
        text: "Good morning Leo, how are you doing today? Anything I should know about?",
      },
    ]);
    await f.store.appendMessage(chat, "assistant", [
      {
        type: "text",
        text: "Good morning! All fine here, nothing urgent on my side today.",
      },
    ]);
    const nothing = await f.learning.reviewer.run(
      (await f.learning.reviewer.enqueue({
        companyId: f.companyId,
        agentId: f.leo,
        sessionId: chat.id,
      }))!,
    );
    expect(nothing.status).toBe("done");
    expect(nothing.applied.memoryIds).toEqual([]);
    expect(nothing.applied.skill).toBeNull();
  });

  it("helpers: transcript trimming and tolerant JSON parsing", () => {
    const text = transcriptOf([{ role: "user", content: [{ type: "text", text: "x".repeat(100) }] }], 40);
    expect(text.startsWith("[... earlier part")).toBe(true);
    expect(parseProposals('Sure! Here it is:\n{"memories":[{"content":"A"}],"skill":null,"retire":[],"reason":"r"}\nThanks')).toMatchObject({
      memories: [{ kind: "note", content: "A" }],
      skill: null,
    });
    expect(parseProposals("no json here")).toBeNull();
  });

  it("reviews are off when the company says so", async () => {
    await f.learning.settings.update(f.companyId, { reviewEnabled: false }, { kind: "person" });
    const session = await f.store.createSession({
      companyId: f.companyId,
      agentId: f.leo,
      kind: "chat",
      title: null,
      systemPrompt: "S",
      systemPromptHash: "h",
      model: "fake/echo",
      fallbackModel: null,
      workdir: null,
      taskId: null,
    });
    expect(
      await f.learning.reviewer.enqueue({
        companyId: f.companyId,
        agentId: f.leo,
        sessionId: session.id,
      }),
    ).toBeNull();
  });
});
