/**
 * Tool connections: MCP servers (a local process over stdio, or a streamable
 * HTTP server) and workflow tools (one HTTP endpoint — an n8n, Zapier or Make
 * workflow — described as a tool). Every tool they expose is named
 * `<connection>__<tool>` and goes through the same gate as a native tool.
 * Connections carry a health status; secrets reach them as environment
 * variables or headers and never the model.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EMAIL_TOOLS, EMAIL_TOOL_RISK, callEmail, checkEmail, emailConfigOf, validateEmailConfig } from "./email.js";
import type { Sql } from "postgres";
import { audit } from "@opifer/db";
import type { ToolDefinition } from "@opifer/sdk";
import { ConnectionError, type Actor, type ConnectionConfig, type ConnectionKind, type ConnectionStatus, type DiscoveredTool, type Risk, type ToolConnection } from "./types.js";

interface Row {
  id: string;
  company_id: string;
  kind: ConnectionKind;
  name: string;
  description: string;
  config: ConnectionConfig;
  risk: Risk;
  secret_names: string[];
  enabled: boolean;
  status: ConnectionStatus;
  status_detail: string | null;
  tools: DiscoveredTool[];
  last_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const toConnection = (r: Row): ToolConnection => ({
  id: r.id,
  companyId: r.company_id,
  kind: r.kind,
  name: r.name,
  description: r.description,
  config: r.config,
  risk: r.risk,
  secretNames: r.secret_names,
  enabled: r.enabled,
  status: r.status,
  statusDetail: r.status_detail,
  tools: r.tools,
  lastCheckedAt: r.last_checked_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const CONNECTION_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const TOOL_SEPARATOR = "__";

/** Replaces `${SECRET_NAME}` placeholders in a string with secret values. */
export function fillSecrets(text: string, secrets: Record<string, string>): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => secrets[name] ?? "");
}

/** Reads company secrets for a connection; null values mark missing ones. */
export type SecretReader = (companyId: string, name: string, purpose: string) => Promise<string | null>;

export interface McpSession {
  client: Client;
  close(): Promise<void>;
}

/** Opens an MCP session for a connection: stdio or streamable HTTP. */
export async function openMcp(connection: ToolConnection, secrets: Record<string, string>): Promise<McpSession> {
  const client = new Client({ name: "opifer", version: "0.1.0" });
  if (connection.kind === "mcp_stdio") {
    if (!connection.config.command) throw new ConnectionError("invalid_input", "an MCP stdio connection needs a command");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && /^(PATH|HOME|LANG|LC_.*|TMPDIR|TEMP|TMP|SYSTEMROOT|USERPROFILE)$/.test(k)) env[k] = v;
    for (const [k, v] of Object.entries(connection.config.env ?? {})) env[k] = fillSecrets(v, secrets);
    for (const name of connection.secretNames) if (secrets[name] !== undefined) env[name] = secrets[name]!;
    const transport = new StdioClientTransport({ command: connection.config.command, args: connection.config.args ?? [], env, stderr: "ignore" });
    await client.connect(transport);
    return { client, close: () => client.close() };
  }
  if (connection.kind === "mcp_http") {
    if (!connection.config.url) throw new ConnectionError("invalid_input", "an MCP HTTP connection needs a url");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(connection.config.headers ?? {})) headers[k] = fillSecrets(v, secrets);
    const transport = new StreamableHTTPClientTransport(new URL(connection.config.url), { requestInit: { headers } });
    // The SDK's transport types are not written for exactOptionalPropertyTypes.
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    return { client, close: () => client.close() };
  }
  throw new ConnectionError("invalid_input", "not an MCP connection");
}

/** Calls a workflow tool: one HTTP request, the response (or one field of it) comes back as text. */
export async function callWorkflow(
  connection: ToolConnection,
  args: Record<string, unknown>,
  secrets: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  if (!connection.config.url) throw new ConnectionError("invalid_input", "a workflow tool needs a url");
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/plain;q=0.8" };
  for (const [k, v] of Object.entries(connection.config.headers ?? {})) headers[k] = fillSecrets(v, secrets);
  const method = connection.config.method ?? "POST";
  const url = new URL(connection.config.url);
  if (method === "GET") for (const [k, v] of Object.entries(args)) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  const response = await fetch(url, { method, headers, ...(method === "POST" ? { body: JSON.stringify(args) } : {}), ...(signal ? { signal } : {}) });
  const text = await response.text();
  let content = text;
  if (connection.config.resultField) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const value = parsed[connection.config.resultField];
      content = typeof value === "string" ? value : JSON.stringify(value ?? parsed);
    } catch {
      // not JSON: the text is the result
    }
  }
  return { content: content.slice(0, 64_000), isError: !response.ok };
}

export class ConnectionService {
  constructor(
    private readonly sql: Sql,
    private readonly readSecret: SecretReader | null = null,
    /** Mail transports, replaced by fakes in tests. */
    private readonly emailDeps: import("./email.js").EmailDeps = {},
  ) {}

  async create(
    input: { companyId: string; kind: ConnectionKind; name: string; description?: string; config: ConnectionConfig; risk?: Risk; secretNames?: string[]; enabled?: boolean },
    actor: Actor,
  ): Promise<ToolConnection> {
    const name = input.name.trim().toLowerCase();
    if (!CONNECTION_NAME.test(name)) throw new ConnectionError("invalid_input", "a connection name is lowercase letters, digits, dashes or underscores (up to 40 characters)");
    if (input.kind === "mcp_stdio" && !input.config.command) throw new ConnectionError("invalid_input", "an MCP stdio connection needs a command");
    if (input.kind === "email") {
      const problem = validateEmailConfig(input.config as never);
      if (problem) throw new ConnectionError("invalid_input", problem);
    } else if (input.kind !== "mcp_stdio" && !input.config.url)
      throw new ConnectionError("invalid_input", `a ${input.kind === "mcp_http" ? "MCP HTTP" : "workflow"} connection needs a url`);
    const [existing] = await this.sql<{ id: string }[]>`SELECT id FROM tool_connections WHERE company_id = ${input.companyId} AND name = ${name}`;
    if (existing) throw new ConnectionError("conflict", `a connection named "${name}" already exists`);
    const tools: DiscoveredTool[] =
      input.kind === "email"
        ? EMAIL_TOOLS
        : input.kind === "workflow"
          ? [
              {
                name: "run",
                description: input.config.toolDescription ?? input.description ?? `Runs the ${name} workflow`,
                inputSchema: input.config.inputSchema ?? { type: "object", properties: {} },
              },
            ]
          : [];
    const [row] = await this.sql<Row[]>`
      INSERT INTO tool_connections (company_id, kind, name, description, config, risk, secret_names, enabled, tools)
      VALUES (${input.companyId}, ${input.kind}, ${name}, ${input.description ?? ""}, ${input.config as never}::jsonb, ${input.risk ?? "medium"}, ${input.kind === "email" ? [input.config.passwordSecret ?? "EMAIL_PASSWORD"] : (input.secretNames ?? [])}, ${input.enabled ?? true}, ${tools as never}::jsonb)
      RETURNING *
    `;
    await audit(this.sql, {
      companyId: input.companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "connection.created",
      subjectKind: "tool_connection",
      subjectId: row!.id,
      after: { kind: input.kind, name, risk: input.risk ?? "medium" },
    });
    return toConnection(row!);
  }

  async get(companyId: string, id: string): Promise<ToolConnection | null> {
    const [row] = await this.sql<Row[]>`SELECT * FROM tool_connections WHERE id = ${id} AND company_id = ${companyId}`;
    return row ? toConnection(row) : null;
  }

  async byName(companyId: string, name: string): Promise<ToolConnection | null> {
    const [row] = await this.sql<Row[]>`SELECT * FROM tool_connections WHERE company_id = ${companyId} AND name = ${name}`;
    return row ? toConnection(row) : null;
  }

  async list(companyId: string, options: { enabledOnly?: boolean } = {}): Promise<ToolConnection[]> {
    const rows = options.enabledOnly
      ? await this.sql<Row[]>`SELECT * FROM tool_connections WHERE company_id = ${companyId} AND enabled ORDER BY name`
      : await this.sql<Row[]>`SELECT * FROM tool_connections WHERE company_id = ${companyId} ORDER BY name`;
    return rows.map(toConnection);
  }

  async update(
    companyId: string,
    id: string,
    patch: { description?: string; config?: ConnectionConfig; risk?: Risk; secretNames?: string[]; enabled?: boolean },
    actor: Actor,
  ): Promise<ToolConnection> {
    const current = await this.get(companyId, id);
    if (!current) throw new ConnectionError("not_found", "connection not found");
    const config = patch.config ?? current.config;
    const tools =
      current.kind === "workflow" && patch.config
        ? [{ name: "run", description: config.toolDescription ?? patch.description ?? current.description, inputSchema: config.inputSchema ?? { type: "object", properties: {} } }]
        : current.tools;
    const [row] = await this.sql<Row[]>`
      UPDATE tool_connections SET description = ${patch.description ?? current.description}, config = ${config as never}::jsonb, risk = ${patch.risk ?? current.risk}, secret_names = ${patch.secretNames ?? current.secretNames}, enabled = ${patch.enabled ?? current.enabled}, tools = ${tools as never}::jsonb
      WHERE id = ${id} RETURNING *
    `;
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "connection.updated",
      subjectKind: "tool_connection",
      subjectId: id,
      after: { ...patch, config: patch.config ? "changed" : undefined },
    });
    return toConnection(row!);
  }

  async remove(companyId: string, id: string, actor: Actor): Promise<void> {
    const current = await this.get(companyId, id);
    if (!current) throw new ConnectionError("not_found", "connection not found");
    await this.sql`DELETE FROM tool_connections WHERE id = ${id}`;
    await audit(this.sql, {
      companyId,
      actorKind: actor.kind,
      actorId: actor.id ?? null,
      action: "connection.removed",
      subjectKind: "tool_connection",
      subjectId: id,
      before: { name: current.name, kind: current.kind },
    });
  }

  /** The secrets a connection needs; missing ones are reported, never guessed. */
  async secretsFor(connection: ToolConnection): Promise<{ values: Record<string, string>; missing: string[] }> {
    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of connection.secretNames) {
      const value = this.readSecret ? await this.readSecret(connection.companyId, name, `connection:${connection.name}`) : null;
      if (value === null) missing.push(name);
      else values[name] = value;
    }
    return { values, missing };
  }

  /** Talks to the server: discovers the tools and records the health. */
  async check(companyId: string, id: string): Promise<ToolConnection> {
    const connection = await this.get(companyId, id);
    if (!connection) throw new ConnectionError("not_found", "connection not found");
    const { values, missing } = await this.secretsFor(connection);
    if (missing.length > 0) return this.setStatus(connection, "missing_secret", `missing secrets: ${missing.join(", ")}`, connection.tools);
    if (connection.kind === "email") {
      const result = await checkEmail(emailConfigOf(connection), values[connection.secretNames[0] ?? "EMAIL_PASSWORD"] ?? "", this.emailDeps);
      return this.setStatus(connection, result.ok ? "healthy" : "failed", result.detail, EMAIL_TOOLS);
    }
    if (connection.kind === "workflow") {
      // A workflow tool has no discovery: reachability only (HEAD may be refused; any answer is a sign of life).
      try {
        const response = await fetch(connection.config.url!, { method: "OPTIONS", signal: AbortSignal.timeout(5000) });
        return this.setStatus(connection, response.status < 500 ? "healthy" : "degraded", `HTTP ${response.status}`, connection.tools);
      } catch (error) {
        return this.setStatus(connection, "failed", error instanceof Error ? error.message : String(error), connection.tools);
      }
    }
    let session: McpSession | null = null;
    try {
      session = await openMcp(connection, values);
      const listed = await session.client.listTools();
      const tools: DiscoveredTool[] = listed.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      }));
      return this.setStatus(connection, "healthy", `${tools.length} tools`, tools);
    } catch (error) {
      return this.setStatus(connection, "failed", error instanceof Error ? error.message : String(error), connection.tools);
    } finally {
      await session?.close().catch(() => {});
    }
  }

  private async setStatus(connection: ToolConnection, status: ConnectionStatus, detail: string, tools: DiscoveredTool[]): Promise<ToolConnection> {
    const [row] = await this.sql<
      Row[]
    >`UPDATE tool_connections SET status = ${status}, status_detail = ${detail}, tools = ${tools as never}::jsonb, last_checked_at = now() WHERE id = ${connection.id} RETURNING *`;
    if (status !== connection.status)
      await audit(this.sql, {
        companyId: connection.companyId,
        actorKind: "system",
        action: "connection.status_changed",
        subjectKind: "tool_connection",
        subjectId: connection.id,
        before: { status: connection.status },
        after: { status, detail },
      });
    return toConnection(row!);
  }

  /** Tool definitions for the model, for one company: `<connection>__<tool>`. */
  async definitionsFor(companyId: string): Promise<Array<ToolDefinition & { risk: Risk; connectionId: string }>> {
    const connections = await this.list(companyId, { enabledOnly: true });
    const out: Array<ToolDefinition & { risk: Risk; connectionId: string }> = [];
    for (const c of connections) {
      if (c.status === "failed" || c.status === "missing_secret") continue;
      for (const t of c.tools)
        out.push({
          name: `${c.name}${TOOL_SEPARATOR}${t.name}`,
          description: `[${c.name}] ${t.description}`.slice(0, 1000),
          inputSchema: t.inputSchema,
          risk: c.kind === "email" ? (EMAIL_TOOL_RISK[t.name] ?? c.risk) : c.risk,
          connectionId: c.id,
        });
    }
    return out;
  }

  /** Runs a connection tool. */
  async call(companyId: string, fullName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: string; isError: boolean }> {
    const idx = fullName.indexOf(TOOL_SEPARATOR);
    if (idx <= 0) throw new ConnectionError("not_found", `not a connection tool: ${fullName}`);
    const connection = await this.byName(companyId, fullName.slice(0, idx));
    const toolName = fullName.slice(idx + TOOL_SEPARATOR.length);
    if (!connection || !connection.enabled) throw new ConnectionError("not_found", `connection not found: ${fullName.slice(0, idx)}`);
    const { values, missing } = await this.secretsFor(connection);
    if (missing.length > 0) {
      await this.setStatus(connection, "missing_secret", `missing secrets: ${missing.join(", ")}`, connection.tools);
      return { content: `The connection "${connection.name}" is missing secrets (${missing.join(", ")}): a person must set them.`, isError: true };
    }
    if (connection.kind === "email") {
      try {
        const result = await callEmail(emailConfigOf(connection), toolName, args, values[connection.secretNames[0] ?? "EMAIL_PASSWORD"] ?? "", this.emailDeps);
        if (connection.status !== "healthy" && !result.isError) await this.setStatus(connection, "healthy", "last call ok", EMAIL_TOOLS);
        return result;
      } catch (error) {
        await this.setStatus(connection, "degraded", error instanceof Error ? error.message : String(error), EMAIL_TOOLS);
        return { content: `The mailbox "${connection.name}" failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    }
    if (connection.kind === "workflow") {
      try {
        const result = await callWorkflow(connection, args, values, signal);
        if (connection.status !== "healthy") await this.setStatus(connection, "healthy", "last call ok", connection.tools);
        return result;
      } catch (error) {
        await this.setStatus(connection, "failed", error instanceof Error ? error.message : String(error), connection.tools);
        return { content: `The workflow "${connection.name}" failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    }
    let session: McpSession | null = null;
    try {
      session = await openMcp(connection, values);
      const result = await session.client.callTool({ name: toolName, arguments: args }, undefined, signal ? { signal } : undefined);
      const parts = Array.isArray(result.content) ? (result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>) : [];
      const text = parts.map((p) => (p.type === "text" ? (p.text ?? "") : p.type === "image" ? `[image ${p.mimeType ?? ""}]` : JSON.stringify(p))).join("\n");
      if (connection.status !== "healthy") await this.setStatus(connection, "healthy", "last call ok", connection.tools);
      return { content: (text || JSON.stringify(result.structuredContent ?? {})).slice(0, 64_000), isError: Boolean(result.isError) };
    } catch (error) {
      await this.setStatus(connection, "degraded", error instanceof Error ? error.message : String(error), connection.tools);
      return { content: `The MCP tool "${fullName}" failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    } finally {
      await session?.close().catch(() => {});
    }
  }
}
