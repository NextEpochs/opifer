/**
 * One executor for native tools and connection tools. Definitions depend on
 * the company: a session sees its company's healthy connections next to the
 * native tools. Risk comes from the connection, so governance treats an MCP
 * tool like any other.
 */

import type { ToolDefinition } from "@opifer/sdk";
import type { ToolContext, ToolExecutor, ToolOutcome, ToolScope } from "@opifer/runtime";
import { TOOL_SEPARATOR, type ConnectionService } from "./connections.js";
import type { Risk } from "./types.js";

export class ConnectionToolExecutor implements ToolExecutor {
  private readonly risks = new Map<string, Risk>();
  private cache = new Map<string, { at: number; defs: Array<ToolDefinition & { risk: Risk }> }>();

  constructor(
    private readonly native: ToolExecutor,
    private readonly connections: ConnectionService,
    private readonly cacheMs = 5000,
  ) {}

  definitions(): ToolDefinition[] {
    return this.native.definitions();
  }

  /** Native tools plus the company's connection tools; cached briefly, a connection change clears it. */
  async definitionsFor(scope: ToolScope): Promise<ToolDefinition[]> {
    const cached = this.cache.get(scope.companyId);
    let defs = cached && Date.now() - cached.at < this.cacheMs ? cached.defs : null;
    if (!defs) {
      defs = await this.connections.definitionsFor(scope.companyId);
      this.cache.set(scope.companyId, { at: Date.now(), defs });
      for (const d of defs) this.risks.set(d.name, d.risk);
    }
    const nativeDefs = this.native.definitionsFor ? await this.native.definitionsFor(scope) : this.native.definitions();
    return [...nativeDefs, ...defs.map(({ risk: _risk, ...d }) => d)];
  }

  invalidate(companyId?: string): void {
    if (companyId) this.cache.delete(companyId);
    else this.cache.clear();
  }

  riskOf(name: string): Risk | undefined {
    return this.native.riskOf?.(name) ?? this.risks.get(name) ?? (name.includes(TOOL_SEPARATOR) ? "medium" : undefined);
  }

  async preflight(name: string, args: Record<string, unknown>, context: ToolContext) {
    return this.native.preflight ? this.native.preflight(name, args, context) : null;
  }

  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    if (!name.includes(TOOL_SEPARATOR) || this.native.definitions().some((d) => d.name === name)) return this.native.execute(name, args, context);
    const result = await this.connections.call(context.companyId, name, args, context.signal);
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  }
}
