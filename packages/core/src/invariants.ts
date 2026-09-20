/**
 * The twenty invariants of Opifer.
 *
 * They are the contract of the system: every feature, present or future,
 * must respect them. Each one has a contract test in `test/invariants.test.ts`
 * that turns green in the indicated milestone.
 */

export type InvariantArea = "core" | "conversation" | "work" | "governance" | "learning";

export interface Invariant {
  /** Stable identifier, used in tests and documentation. */
  readonly id: string;
  readonly area: InvariantArea;
  readonly title: string;
  readonly rule: string;
  /** Milestone in which the contract test must be green. */
  readonly milestone: "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7";
}

export const INVARIANTS: readonly Invariant[] = [
  // Core
  {
    id: "narrow-core",
    area: "core",
    title: "Narrow core, capabilities at the edges",
    rule: "The core contains only the loop, data, governance and scheduler. Providers, channels, tools, external memories and sandboxes are plugins.",
    milestone: "M5",
  },
  {
    id: "single-store",
    area: "core",
    title: "A single store",
    rule: "All state lives in PostgreSQL: tasks, memory, skills, costs, audit, queues. No mandatory second database.",
    milestone: "M0",
  },
  {
    id: "every-row-belongs-to-a-company",
    area: "core",
    title: "Every row belongs to a company",
    rule: "The company_id field is present everywhere from day one; isolation between companies is verified at the query and test level.",
    milestone: "M0",
  },
  {
    id: "single-language",
    area: "core",
    title: "A single language",
    rule: "TypeScript for server, UI, CLI and SDK.",
    milestone: "M0",
  },
  // Conversation and costs
  {
    id: "stable-prefix",
    area: "conversation",
    title: "Stable prefix",
    rule: "The system prompt does not change for the whole life of a conversation. Memory and skills enter as a snapshot at session start.",
    milestone: "M1",
  },
  {
    id: "single-break",
    area: "conversation",
    title: "A single break allowed",
    rule: "The only change to past context is compression, executed at a threshold and tracked.",
    milestone: "M6",
  },
  {
    id: "strict-role-alternation",
    area: "conversation",
    title: "Strict role alternation",
    rule: "Never two consecutive messages with the same role; content injected mid-turn travels in a tool result or in a user message at the turn boundary.",
    milestone: "M1",
  },
  {
    id: "budget-before-the-call",
    area: "conversation",
    title: "Budget before the call",
    rule: "Every model call and every paid tool goes through a spending reservation. If the ceiling is reached, the call does not start.",
    milestone: "M2",
  },
  // Work
  {
    id: "atomic-checkout",
    area: "work",
    title: "Atomic checkout",
    rule: "A task in progress has a single assignee; taking it on is a single transaction, with no possible duplicates.",
    milestone: "M3",
  },
  {
    id: "every-task-knows-its-why",
    area: "work",
    title: "Every task knows its why",
    rule: "A task carries the chain goal → project → company mission.",
    milestone: "M3",
  },
  {
    id: "at-most-once",
    area: "work",
    title: "At most once",
    rule: "Scheduled runs advance the next due time before starting: a crash never produces a double run.",
    milestone: "M5",
  },
  {
    id: "no-tool-replay",
    area: "work",
    title: "No automatic tool replay",
    rule: "After an interruption the conversation resumes from the saved history, without re-running actions already performed.",
    milestone: "M1",
  },
  {
    id: "done-means-verified",
    area: "work",
    title: "Done means verified",
    rule: "A task closes with a checkable result (artifact, test, decision), not with a status message.",
    milestone: "M3",
  },
  // Governance
  {
    id: "permission-per-role-on-every-tool",
    area: "governance",
    title: "Permission per role on every tool",
    rule: "Three states: automatic, with approval, blocked. The default is cautious.",
    milestone: "M2",
  },
  {
    id: "secrets-never-in-context",
    area: "governance",
    title: "Secrets never in context",
    rule: "Credentials are bound to agent and company, resolved at the moment of use, and every access is recorded.",
    milestone: "M2",
  },
  {
    id: "immutable-audit",
    area: "governance",
    title: "Immutable audit",
    rule: "Every state-changing action records who, what, when and on behalf of which task. The log is neither modified nor deleted.",
    milestone: "M0",
  },
  {
    id: "versioned-configuration",
    area: "governance",
    title: "Versioned configuration",
    rule: "Every change to an agent, a skill or a policy creates a revision, which can be restored.",
    milestone: "M2",
  },
  // Learning
  {
    id: "learn-outside-the-turn",
    area: "learning",
    title: "Learn outside the turn",
    rule: "The review that proposes new memories or skills runs in the background, on a copy of the conversation, without touching the live context.",
    milestone: "M4",
  },
  {
    id: "never-delete-what-was-learned",
    area: "learning",
    title: "Never delete what was learned",
    rule: "Unused skills are archived and remain restorable; those pinned by the user are not touched.",
    milestone: "M4",
  },
  {
    id: "knowledge-rises-only-with-governance",
    area: "learning",
    title: "Knowledge rises a level only with governance",
    rule: "A skill moves from agent to team to company according to a policy: automatic, with human review, or forbidden.",
    milestone: "M4",
  },
] as const;

export function invariantById(id: string): Invariant {
  const found = INVARIANTS.find((i) => i.id === id);
  if (!found) throw new Error(`Unknown invariant: ${id}`);
  return found;
}
