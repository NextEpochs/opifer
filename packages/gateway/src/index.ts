/**
 * Gateway dei tool (M2, M5).
 *
 * Registro unico: ogni tool, nativo, MCP o plugin, ha nome, schema, costo
 * stimato e livello di rischio. Ogni chiamata attraversa permesso del ruolo,
 * eventuale approvazione, prenotazione di budget, iniezione dei segreti,
 * esecuzione e audit. In M0 sono fissate le forme.
 */

import type { ToolDefinition } from "@opifer/sdk";

/** Permesso per ruolo su ogni tool: il default è prudente. */
export type ToolPermission = "automatico" | "con_approvazione" | "bloccato";

export const DEFAULT_TOOL_PERMISSION: ToolPermission = "con_approvazione";

export type RiskLevel = "basso" | "medio" | "alto";

export type ToolOrigin = "nativo" | "mcp" | "plugin" | "workflow";

export interface RegisteredTool extends ToolDefinition {
  origin: ToolOrigin;
  risk: RiskLevel;
  /** Costo stimato per chiamata, se il tool è a pagamento. */
  estimatedCost: number | null;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool già registrato: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
