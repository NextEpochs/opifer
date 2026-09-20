/**
 * The governed executor: every tool call goes through permission, optional
 * approval, secret injection, execution, redaction and audit. It wraps the
 * runtime's executor, which only knows how to run tools.
 */

import type { ToolDefinition } from "@opifer/sdk";
import { audit } from "@opifer/db";
import { classifyCommand } from "@opifer/runtime";
import type { ApprovalNeeded, ToolContext, ToolExecutor, ToolOutcome, ToolScope } from "@opifer/runtime";
import type { Sql } from "postgres";
import type { PermissionService, ResolvedPermission, RiskLevel } from "./permissions.js";
import { redactSecrets } from "./redaction.js";
import type { SecretService } from "./secrets.js";

export interface GovernedToolExecutorOptions {
  sql: Sql;
  inner: ToolExecutor;
  permissions: PermissionService;
  secrets?: SecretService;
  /** Risk of tools the inner executor does not declare. */
  defaultRisk?: RiskLevel;
}

export class GovernedToolExecutor implements ToolExecutor {
  private readonly sql: Sql;
  private readonly inner: ToolExecutor;
  private readonly permissions: PermissionService;
  private readonly secrets: SecretService | undefined;
  private readonly defaultRisk: RiskLevel;

  constructor(options: GovernedToolExecutorOptions) {
    this.sql = options.sql;
    this.inner = options.inner;
    this.permissions = options.permissions;
    this.secrets = options.secrets;
    this.defaultRisk = options.defaultRisk ?? "high";
  }

  definitions(): ToolDefinition[] {
    return this.inner.definitions();
  }

  async definitionsFor(scope: ToolScope): Promise<ToolDefinition[]> {
    return this.inner.definitionsFor ? this.inner.definitionsFor(scope) : this.inner.definitions();
  }

  riskOf(name: string): RiskLevel {
    return this.inner.riskOf?.(name) ?? this.defaultRisk;
  }

  private async resolve(name: string, context: ToolContext): Promise<ResolvedPermission> {
    return this.permissions.resolve({ companyId: context.companyId, agentId: context.agentId, agentRole: context.agentRole, toolName: name, risk: this.riskOf(name) });
  }

  /** What a person must approve before this call runs: the tool itself, or a dangerous command. */
  private needsApproval(name: string, args: Record<string, unknown>, resolved: ResolvedPermission): ApprovalNeeded | null {
    if (resolved.permission === "approval") {
      return {
        kind: "tool_use",
        reason: `tool ${name} requires approval (${resolved.source} policy)`,
        risk: resolved.risk,
        subject: { permission: resolved.permission, source: resolved.source },
      };
    }
    if (name === "terminal" && typeof args["command"] === "string") {
      const verdict = classifyCommand(args["command"]);
      if (verdict.class === "dangerous") {
        return { kind: "dangerous_command", reason: `dangerous command: ${verdict.reason}`, risk: "high", subject: { command: args["command"] } };
      }
    }
    return null;
  }

  async preflight(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ApprovalNeeded | null> {
    if (context.approved) return null;
    const resolved = await this.resolve(name, context);
    if (resolved.permission === "blocked") return null; // execute() refuses it, no one needs to decide
    return this.needsApproval(name, args, resolved);
  }

  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
    const resolved = await this.resolve(name, context);
    // The subject is the run (a uuid); the call id, chosen by the provider, travels in the payload.
    const base = { companyId: context.companyId, actorKind: "agent" as const, actorId: context.agentId, subjectKind: "run", subjectId: context.runId };
    if (resolved.permission === "blocked") {
      await audit(this.sql, { ...base, action: "tool.blocked", after: { tool: name, callId: context.callId, source: resolved.source } });
      return { content: `Tool ${name} is blocked for this agent by policy.`, isError: true };
    }
    const needed = context.approved ? null : this.needsApproval(name, args, resolved);
    if (needed) {
      await audit(this.sql, { ...base, action: "tool.refused", after: { tool: name, callId: context.callId, reason: needed.reason } });
      return { content: `Not executed: ${needed.reason}, and no approval was granted.`, isError: true };
    }

    const secrets = this.secrets
      ? await this.secrets.resolveFor({ companyId: context.companyId, agentId: context.agentId, sessionId: context.sessionId, runId: context.runId, toolName: name })
      : {};
    const started = Date.now();
    const outcome = await this.inner.execute(name, args, { ...context, ...(Object.keys(secrets).length > 0 ? { secrets } : {}) });
    const durationMs = Date.now() - started;
    const content = redactSecrets(outcome.content, secrets);
    await audit(this.sql, {
      ...base,
      action: "tool.executed",
      after: {
        tool: name,
        callId: context.callId,
        sessionId: context.sessionId,
        permission: resolved.permission,
        source: resolved.source,
        approved: context.approved ?? false,
        secrets: Object.keys(secrets),
        isError: outcome.isError ?? false,
        durationMs,
        chars: content.length,
      },
    });
    return { ...outcome, content };
  }
}
