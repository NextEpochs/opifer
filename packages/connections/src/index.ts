/**
 * Connections (M5): tool connections (MCP servers, workflow tools) behind
 * the same gate as native tools, inbound webhooks, outbound signed events,
 * messaging channels.
 */

export { ConnectionService, openMcp, callWorkflow, fillSecrets, CONNECTION_NAME, TOOL_SEPARATOR } from "./connections.js";
export type { SecretReader, McpSession } from "./connections.js";
export { ConnectionToolExecutor } from "./executor.js";
export { WebhookService, hashToken, newToken } from "./webhooks.js";
export type { WebhookHandlers } from "./webhooks.js";
export { EventService, signPayload } from "./events.js";
export { ChannelService, newPairingCode } from "./channels.js";
export { ConnectionError } from "./types.js";
export type * from "./types.js";
export { EMAIL_TOOLS, EMAIL_TOOL_RISK, callEmail, checkEmail, validateEmailConfig } from "./email.js";
export type { EmailConfig, EmailDeps } from "./email.js";
