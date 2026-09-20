import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkError, WorkService } from "../src/index.js";

interface Fixture {
  db: TestDatabase;
  work: WorkService;
  companyId: string;
  agentId: string;
  otherAgentId: string;
  auditCount(action: string, companyId?: string): Promise<number>;
}

async function createFixture(options: { leaseMs?: number; failureThreshold?: number } = {}): Promise<Fixture> {
  const db = await createTestDatabase();
  const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name, mission) VALUES ('Workshop', 'Ship useful software for small companies') RETURNING id`;
  const [agent] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name, role) VALUES (${company!.id}, 'Philip', 'CEO') RETURNING id`;
  const [other] = await db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name, role) VALUES (${company!.id}, 'Nora', 'Researcher') RETURNING id`;
  const work = new WorkService(db.sql, { leaseMs: options.leaseMs ?? 60_000, failureThreshold: options.failureThreshold ?? 2 });
  return {
    db,
    work,
    companyId: company!.id,
    agentId: agent!.id,
    otherAgentId: other!.id,
    auditCount: async (action, companyId = company!.id) => {
      const [row] = await db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM audit_log WHERE company_id = ${companyId} AND action = ${action}`;
      return Number(row!.n);
    },
  };
}

describe("work: atomic checkout and leases", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture({ leaseMs: 200 });
  }, 120_000);

  afterAll(async () => {
    await f?.db.destroy();
  });

  it("100 concurrent checkouts of the same task: exactly one succeeds", async () => {
    const task = await f.work.createTask({ companyId: f.companyId, title: "Write the pricing page", assigneeAgentId: f.agentId }, { kind: "person" });
    const outcomes = await Promise.all(
      Array.from({ length: 100 }, (_, i) => f.work.checkout(f.companyId, task.id, { agentId: f.agentId, runId: null, sessionId: null }, new Date(Date.now() + i))),
    );
    const winners = outcomes.filter((o) => o.ok);
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok && o.reason === "taken")).toHaveLength(99);
    expect(await f.auditCount("task.checked_out")).toBe(1);
    const stored = await f.work.getTask(f.companyId, task.id);
    expect(stored?.status).toBe("in_progress");
    expect(stored?.leaseExpiresAt).not.toBeNull();
  });

  it("only the assignee can check out; a task on a person is not available to agents", async () => {
    const task = await f.work.createTask({ companyId: f.companyId, title: "Nora's job", assigneeAgentId: f.otherAgentId }, { kind: "person" });
    expect(await f.work.checkout(f.companyId, task.id, { agentId: f.agentId })).toMatchObject({ ok: false, reason: "not_assignee" });
    expect(await f.work.checkout(f.companyId, "00000000-0000-0000-0000-000000000000", { agentId: f.agentId })).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("an abandoned lease is released within the threshold and counts as a failure; the second one blocks the task", async () => {
    const task = await f.work.createTask({ companyId: f.companyId, title: "Flaky job", assigneeAgentId: f.agentId }, { kind: "person" });
    const first = await f.work.checkout(f.companyId, task.id, { agentId: f.agentId });
    expect(first.ok).toBe(true);
    // Heartbeats keep the lease alive.
    expect(await f.work.heartbeat(task.id, { runId: null, sessionId: null })).toBe(false); // no holder id: not ours
    const [row] = await f.db.sql<{ lease_expires_at: Date }[]>`SELECT lease_expires_at FROM tasks WHERE id = ${task.id}`;
    // Wait past the lease, then sweep.
    await new Promise((r) => setTimeout(r, 250));
    const freed = await f.work.releaseExpiredLeases();
    expect(freed.some((t) => t.id === task.id)).toBe(true);
    let stored = await f.work.getTask(f.companyId, task.id);
    expect(stored).toMatchObject({ status: "todo", failures: 1, leaseExpiresAt: null });
    expect(await f.auditCount("task.lease_expired")).toBeGreaterThanOrEqual(1);
    expect(row!.lease_expires_at.getTime()).toBeLessThan(Date.now());
    // A retry wake-up was queued for the assignee.
    const wakeups = await f.work.listWakeups(f.companyId, { status: "pending" });
    expect(wakeups.some((w) => w.reason === "retry" && w.taskId === task.id)).toBe(true);

    // Second abandonment: blocked, asks for help.
    expect((await f.work.checkout(f.companyId, task.id, { agentId: f.agentId })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    await f.work.releaseExpiredLeases();
    stored = await f.work.getTask(f.companyId, task.id);
    expect(stored).toMatchObject({ status: "blocked", failures: 2 });
    expect(stored?.blockedReason).toMatch(/2 abandoned/);
    // Unblocking resets and wakes the assignee.
    const unblocked = await f.work.unblock(f.companyId, task.id, { kind: "person" });
    expect(unblocked).toMatchObject({ status: "todo", failures: 0 });
  });

  it("a live heartbeat keeps the lease; an expired lease can be taken over by the assignee", async () => {
    const task = await f.work.createTask({ companyId: f.companyId, title: "Long job", assigneeAgentId: f.agentId }, { kind: "person" });
    const [session] = await f.db.sql<
      { id: string }[]
    >`INSERT INTO sessions (company_id, agent_id, system_prompt, system_prompt_hash, model, kind, task_id) VALUES (${f.companyId}, ${f.agentId}, 'p', 'h', 'fake/echo', 'task', ${task.id}) RETURNING id`;
    const [run] = await f.db.sql<{ id: string }[]>`INSERT INTO runs (company_id, session_id, agent_id) VALUES (${f.companyId}, ${session!.id}, ${f.agentId}) RETURNING id`;
    expect((await f.work.checkout(f.companyId, task.id, { agentId: f.agentId, sessionId: session!.id, runId: run!.id })).ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 120));
      expect(await f.work.heartbeat(task.id, { runId: run!.id })).toBe(true);
    }
    expect(await f.work.releaseExpiredLeases()).toHaveLength(0);
    expect((await f.work.getTask(f.companyId, task.id))?.status).toBe("in_progress");
    // Let it expire: the assignee's next checkout takes over the stale lease directly.
    await new Promise((r) => setTimeout(r, 250));
    const retaken = await f.work.checkout(f.companyId, task.id, { agentId: f.agentId });
    expect(retaken.ok).toBe(true);
    expect(await f.work.heartbeat(task.id, { runId: run!.id })).toBe(false);
  });
});

describe("work: the why chain, results and isolation", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await createFixture();
  }, 120_000);

  afterAll(async () => {
    await f?.db.destroy();
  });

  it("every task knows its why: mission → goals → project → parents", async () => {
    const person = { kind: "person" as const };
    const root = await f.work.createGoal({ companyId: f.companyId, title: "Reach 100 paying customers", measure: "100 active subscriptions" }, person);
    const child = await f.work.createGoal({ companyId: f.companyId, title: "Launch the pricing page", parentId: root.id }, person);
    const project = await f.work.createProject({ companyId: f.companyId, name: "Website", goalId: child.id }, person);
    const parent = await f.work.createTask({ companyId: f.companyId, title: "Rebuild the website", projectId: project.id }, person);
    const task = await f.work.createTask({ companyId: f.companyId, title: "Write the pricing copy", parentId: parent.id, assigneeAgentId: f.agentId }, person);
    expect(task.projectId).toBe(project.id);
    expect(task.goalId).toBe(child.id);
    const why = await f.work.whyChain(f.companyId, task);
    expect(why.mission).toBe("Ship useful software for small companies");
    expect(why.goals.map((g) => g.title)).toEqual(["Reach 100 paying customers", "Launch the pricing page"]);
    expect(why.project?.name).toBe("Website");
    expect(why.parents.map((p) => p.title)).toEqual(["Rebuild the website"]);
    expect(await f.auditCount("goal.created")).toBe(2);
    expect(await f.auditCount("project.created")).toBe(1);
    expect(await f.auditCount("task.created")).toBe(2);
  });

  it("done means verified: no result, no done; a parent waits for its children", async () => {
    const person = { kind: "person" as const };
    const parent = await f.work.createTask({ companyId: f.companyId, title: "Parent", assigneeAgentId: f.agentId }, person);
    const child = await f.work.createTask({ companyId: f.companyId, title: "Child", parentId: parent.id, assigneeAgentId: f.agentId }, person);
    expect((await f.work.checkout(f.companyId, parent.id, { agentId: f.agentId })).ok).toBe(true);
    // The database itself refuses a done task without a result.
    await expect(f.db.sql`UPDATE tasks SET status = 'done' WHERE id = ${parent.id}`).rejects.toThrow(/done means verified/);
    await expect(f.work.complete(f.companyId, parent.id, { summary: "" }, person)).rejects.toThrow(/summary/);
    await expect(f.work.complete(f.companyId, parent.id, { summary: "all good" }, person)).rejects.toThrow(/subtasks are still open/);

    expect((await f.work.checkout(f.companyId, child.id, { agentId: f.agentId })).ok).toBe(true);
    await f.work.addProduct(f.companyId, child.id, { kind: "file", title: "pricing.html", ref: "site/pricing.html", summary: "the page" }, { kind: "agent", id: f.agentId });
    const reviewed = await f.work.requestReview(f.companyId, child.id, { summary: "Pricing page written, three tiers" }, { kind: "agent", id: f.agentId });
    expect(reviewed.status).toBe("in_review");
    // Changes requested: back to todo, the assignee wakes up, a comment explains.
    const back = await f.work.requestChanges(f.companyId, child.id, "add the enterprise tier", person);
    expect(back.status).toBe("todo");
    expect((await f.work.listComments(f.companyId, child.id)).at(-1)?.body).toMatch(/enterprise tier/);
    expect((await f.work.checkout(f.companyId, child.id, { agentId: f.agentId })).ok).toBe(true);
    await f.work.requestReview(f.companyId, child.id, { summary: "Added the enterprise tier" }, { kind: "agent", id: f.agentId });
    const done = await f.work.complete(f.companyId, child.id, { summary: "Pricing page with four tiers", verification: "opened in the browser" }, person);
    expect(done.status).toBe("done");
    expect(done.result?.summary).toBe("Pricing page with four tiers");
    const parentDone = await f.work.complete(f.companyId, parent.id, { summary: "Website rebuilt" }, person);
    expect(parentDone.status).toBe("done");
    expect(await f.auditCount("task.done")).toBe(2);
    expect(await f.auditCount("task.review_requested")).toBe(2);
    expect(await f.auditCount("task.product_added")).toBe(1);
  });

  it("comments wake mentioned agents once, and a person's comment wakes the assignee", async () => {
    const person = { kind: "person" as const };
    const task = await f.work.createTask({ companyId: f.companyId, title: "Discuss", assigneeAgentId: f.agentId }, person);
    const pendingBefore = (await f.work.listWakeups(f.companyId, { status: "pending" })).length;
    const c = await f.work.comment(f.companyId, task.id, person, "@Nora can you check this with @Philip?");
    expect(c.mentions.sort()).toEqual([f.agentId, f.otherAgentId].sort());
    await f.work.comment(f.companyId, task.id, person, "@Nora again");
    const pending = await f.work.listWakeups(f.companyId, { status: "pending" });
    // mention Nora + mention Philip (also the assignee: one wake-up, not two); the second mention of Nora is absorbed.
    expect(pending.length - pendingBefore).toBe(2);
    // An agent commenting does not wake itself.
    await f.work.comment(f.companyId, task.id, { kind: "agent", id: f.agentId }, "on it, @Philip");
    expect((await f.work.listWakeups(f.companyId, { status: "pending" })).length - pendingBefore).toBe(2);
    expect(await f.auditCount("task.commented")).toBe(4);
  });

  it("wake-ups are claimed at most once, even by 50 concurrent claimers", async () => {
    const [company] = await f.db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Claims') RETURNING id`;
    const [agent] = await f.db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name) VALUES (${company!.id}, 'Worker') RETURNING id`;
    const created = await Promise.all(Array.from({ length: 10 }, (_, i) => f.work.wake(company!.id, agent!.id, "external", { dedupeKey: `ext:${i}` })));
    expect(created.every((w) => w !== null)).toBe(true);
    expect(await f.work.wake(company!.id, agent!.id, "external", { dedupeKey: "ext:1" })).toBeNull();
    const claims = (await Promise.all(Array.from({ length: 50 }, () => f.work.claimWakeup()))).filter((w): w is NonNullable<typeof w> => w !== null && w.companyId === company!.id);
    expect(new Set(claims.map((w) => w.id)).size).toBe(claims.length);
    expect(claims.length).toBe(10);
    for (const w of claims) await f.work.finishWakeup(w.id, "done");
    expect((await f.work.listWakeups(company!.id, { status: "pending" })).length).toBe(0);
    // A crashed claimer's row goes back to pending after the stale threshold.
    const stale = await f.work.wake(company!.id, agent!.id, "external", { dedupeKey: "ext:stale" });
    await f.work.claimWakeup();
    await f.db.sql`UPDATE wakeups SET claimed_at = now() - interval '1 hour' WHERE id = ${stale!.id}`;
    expect(await f.work.requeueStaleWakeups(10 * 60_000)).toBe(1);
  });

  it("two companies are isolated: tasks, checkouts, comments and wake-ups never cross", async () => {
    const person = { kind: "person" as const };
    const [other] = await f.db.sql<{ id: string }[]>`INSERT INTO companies (name) VALUES ('Other Co') RETURNING id`;
    const [otherAgent] = await f.db.sql<{ id: string }[]>`INSERT INTO agents (company_id, name) VALUES (${other!.id}, 'Philip') RETURNING id`;
    const mine = await f.work.createTask({ companyId: f.companyId, title: "Mine", assigneeAgentId: f.agentId }, person);
    const theirs = await f.work.createTask({ companyId: other!.id, title: "Theirs", assigneeAgentId: otherAgent!.id }, person);
    expect(await f.work.getTask(other!.id, mine.id)).toBeNull();
    expect((await f.work.listTasks(other!.id)).map((t) => t.id)).toEqual([theirs.id]);
    expect(await f.work.checkout(other!.id, mine.id, { agentId: f.agentId })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await f.work.checkout(f.companyId, theirs.id, { agentId: otherAgent!.id })).toMatchObject({ ok: false, reason: "not_found" });
    await expect(f.work.comment(other!.id, mine.id, person, "hi")).rejects.toThrow(WorkError);
    // A mention of "Philip" in the other company wakes their Philip, never ours.
    await f.work.comment(other!.id, theirs.id, person, "@Philip go");
    const theirWakeups = await f.work.listWakeups(other!.id, { status: "pending" });
    expect(theirWakeups.every((w) => w.agentId === otherAgent!.id)).toBe(true);
    expect((await f.work.listWakeups(f.companyId, { status: "pending" })).every((w) => w.companyId === f.companyId)).toBe(true);
    await expect(f.work.complete(other!.id, mine.id, { summary: "x" }, person)).rejects.toThrow(/not found/);
    expect(await f.auditCount("task.created", other!.id)).toBe(1);
  });
});
