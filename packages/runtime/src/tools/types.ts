import type { ToolDefinition } from "@opifer/sdk";

export interface ToolContext {
  sessionId: string;
  companyId: string;
  agentId: string;
  runId: string;
  callId: string;
  /** Role of the agent in the org chart, for permission resolution. */
  agentRole: string;
  workdir: string;
  signal: AbortSignal;
  /** A person approved this exact call: governance must not ask again. */
  approved?: boolean;
  /** The task the session works on, if any. */
  taskId?: string | null;
  /** Secret values bound to this agent and tool, injected at execution time and never shown to the model. */
  secrets?: Record<string, string>;
}

export interface ApprovalNeeded {
  kind: "tool_use" | "dangerous_command";
  reason: string;
  risk: "low" | "medium" | "high";
  subject: Record<string, unknown>;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  /** The turn stops after this tool (for example a question to the person). */
  endTurn?: { stopReason: string };
  /** Governance asks a person before running this call; the turn suspends until the decision. */
  approvalNeeded?: ApprovalNeeded;
}

export interface NativeTool {
  definition: ToolDefinition;
  /** Risk level, used by governance (M2) for the default permission. */
  risk: "low" | "medium" | "high";
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>;
}

export interface ToolExecutor {
  definitions(): ToolDefinition[];
  /** Definitions for one company and agent, when tools differ per company (connections); falls back to `definitions()`. */
  definitionsFor?(scope: { companyId: string; agentId: string }): Promise<ToolDefinition[]>;
  execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>;
  /** Governance check without executing: what a person must approve first, if anything. */
  preflight?(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ApprovalNeeded | null>;
  /** Declared risk of a tool, when known. */
  riskOf?(name: string): "low" | "medium" | "high" | undefined;
}

/** Executor of native tools: no governance (it arrives with the gateway in M2). */
export class NativeToolExecutor implements ToolExecutor {
  private readonly tools = new Map<string, NativeTool>();

  constructor(tools: NativeTool[] = []) {
    for (const tool of tools) this.add(tool);
  }

  add(tool: NativeTool): this {
    if (this.tools.has(tool.definition.name)) throw new Error(`Tool already registered: ${tool.definition.name}`);
    this.tools.set(tool.definition.name, tool);
    return this;
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  riskOf(name: string): NativeTool["risk"] | undefined {
    return this.tools.get(name)?.risk;
  }

  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
    try {
      return await tool.execute(args, context);
    } catch (error) {
      return { content: `Error in tool ${name}: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  }
}
