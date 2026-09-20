/**
 * Tool gateway (M2): the single door every tool call goes through.
 *
 * Permission per role on every tool, approvals a person decides, budget
 * reserved before every paid call, secrets injected at execution time and
 * never shown to the model, audit of every step.
 */

export { PriceBook } from "./prices.js";
export type { Money, PriceBookOptions } from "./prices.js";
export { BudgetService } from "./budget.js";
export type { BudgetPolicy, BudgetScope, BudgetWindow, Spending } from "./budget.js";
export { PermissionService, defaultPermissionForRisk } from "./permissions.js";
export type { ToolPermission, RiskLevel, PolicyTarget, ToolPolicy, ResolvedPermission } from "./permissions.js";
export { ApprovalService, ApprovalError } from "./approvals.js";
export type { Approval, ApprovalKind, ApprovalStatus, ApprovalServiceOptions, ApprovalInput } from "./approvals.js";
export { SecretService, SecretCipher, loadMasterKey } from "./secrets.js";
export type { SecretInfo, SecretBinding, SecretResolution } from "./secrets.js";
export { redactSecrets } from "./redaction.js";
export { GovernedToolExecutor } from "./governed.js";
export type { GovernedToolExecutorOptions } from "./governed.js";
export { AgentConfigService } from "./agents.js";
export type { AgentConfig, AgentRevision, AgentStatus } from "./agents.js";
