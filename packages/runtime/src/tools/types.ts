import type { ToolDefinition } from "@opifer/sdk";

export interface ToolContext {
  sessionId: string;
  companyId: string;
  agentId: string;
  workdir: string;
  signal: AbortSignal;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  /** The turn stops after this tool (for example a question to the person). */
  endTurn?: { stopReason: string };
}

export interface NativeTool {
  definition: ToolDefinition;
  /** Risk level, used by governance (M2) for the default permission. */
  risk: "low" | "medium" | "high";
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>;
}

export interface ToolExecutor {
  definitions(): ToolDefinition[];
  execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>;
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
