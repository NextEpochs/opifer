/**
 * Tool gateway (M2, M5).
 *
 * Single registry: every tool, native, MCP or plugin, has a name, schema,
 * estimated cost and risk level. Every call goes through role permission,
 * optional approval, budget reservation, secret injection, execution and
 * audit. In M0 the shapes are fixed.
 */

import type { ToolDefinition } from "@opifer/sdk";

/** Permission per role on every tool: the default is cautious. */
export type ToolPermission = "automatic" | "approval" | "blocked";

export const DEFAULT_TOOL_PERMISSION: ToolPermission = "approval";

export type RiskLevel = "low" | "medium" | "high";

export type ToolOrigin = "native" | "mcp" | "plugin" | "workflow";

export interface RegisteredTool extends ToolDefinition {
  origin: ToolOrigin;
  risk: RiskLevel;
  /** Estimated cost per call, if the tool is paid. */
  estimatedCost: number | null;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
