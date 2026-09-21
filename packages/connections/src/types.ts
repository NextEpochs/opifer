export type ActorKind = "person" | "agent" | "system";

export interface Actor {
  kind: ActorKind;
  id?: string | null;
}

export type ConnectionKind = "mcp_stdio" | "mcp_http" | "workflow" | "email";
export type ConnectionStatus = "unknown" | "healthy" | "degraded" | "failed" | "missing_secret";
export type Risk = "low" | "medium" | "high";

export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** mcp_stdio: a local process; mcp_http: a streamable HTTP server; workflow: one HTTP endpoint described as a tool. */
export interface ConnectionConfig {
  // mcp_stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // mcp_http and workflow
  url?: string;
  headers?: Record<string, string>;
  // workflow
  method?: "POST" | "GET";
  inputSchema?: Record<string, unknown>;
  /** Tool description shown to the model (workflow). */
  toolDescription?: string;
  /** JSON field of the response returned to the model (workflow); the whole body otherwise. */
  resultField?: string;
  // email: see EmailConfig in email.ts (smtpHost, smtpPort, smtpSecure, imapHost, imapPort, imapSecure, user, from, passwordSecret)
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  user?: string;
  from?: string;
  passwordSecret?: string;
}

export interface ToolConnection {
  id: string;
  companyId: string;
  kind: ConnectionKind;
  name: string;
  description: string;
  config: ConnectionConfig;
  risk: Risk;
  secretNames: string[];
  enabled: boolean;
  status: ConnectionStatus;
  statusDetail: string | null;
  tools: DiscoveredTool[];
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type WebhookAction = "create_task" | "wake_agent" | "comment" | "decide_approval";

export interface Webhook {
  id: string;
  companyId: string;
  name: string;
  action: WebhookAction;
  defaults: Record<string, unknown>;
  enabled: boolean;
  calls: number;
  lastCalledAt: Date | null;
  createdAt: Date;
}

export interface EventSubscription {
  id: string;
  companyId: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  failures: number;
  lastDeliveredAt: Date | null;
  createdAt: Date;
}

export interface EventDelivery {
  id: string;
  companyId: string;
  subscriptionId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: Date;
  responseStatus: number | null;
  error: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

export type ChannelKind = "telegram";

export interface ChannelRecord {
  id: string;
  companyId: string;
  kind: ChannelKind;
  name: string;
  secretName: string;
  defaultAgentId: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  status: "unknown" | "healthy" | "failed" | "missing_secret";
  statusDetail: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export interface ChannelBinding {
  id: string;
  companyId: string;
  channelId: string;
  externalSenderId: string;
  externalChatId: string;
  userId: string | null;
  displayName: string;
  pairingCode: string | null;
  pairingExpiresAt: Date | null;
  agentId: string | null;
  sessionId: string | null;
  notify: boolean;
  lastMessageAt: Date | null;
  createdAt: Date;
}

export class ConnectionError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_input" | "conflict" | "unavailable" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}
