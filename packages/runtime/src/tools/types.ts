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
  /** Il turno si ferma dopo questo tool (per esempio una domanda alla persona). */
  endTurn?: { stopReason: string };
}

export interface NativeTool {
  definition: ToolDefinition;
  /** Livello di rischio, usato dal governo (M2) per il permesso di default. */
  risk: "basso" | "medio" | "alto";
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>;
}

export interface ToolExecutor {
  definitions(): ToolDefinition[];
  execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome>;
}

/** Esecutore dei tool nativi: nessun governo (arriva con il gateway in M2). */
export class NativeToolExecutor implements ToolExecutor {
  private readonly tools = new Map<string, NativeTool>();

  constructor(tools: NativeTool[] = []) {
    for (const tool of tools) this.add(tool);
  }

  add(tool: NativeTool): this {
    if (this.tools.has(tool.definition.name)) throw new Error(`Tool già registrato: ${tool.definition.name}`);
    this.tools.set(tool.definition.name, tool);
    return this;
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) return { content: `Tool sconosciuto: ${name}`, isError: true };
    try {
      return await tool.execute(args, context);
    } catch (error) {
      return { content: `Errore nel tool ${name}: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  }
}
