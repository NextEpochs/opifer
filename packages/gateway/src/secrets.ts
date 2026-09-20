/**
 * Secrets: encrypted per company with a key derived from a master key that
 * lives only on disk (OPIFER_HOME/credentials/master.key, mode 0600).
 * Values are injected into tools at execution time and never enter the
 * model context; every resolution is recorded.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "postgres";
import { audit } from "@opifer/db";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface SecretInfo {
  name: string;
  version: number;
  createdAt: Date;
  createdBy: string | null;
}

export interface SecretBinding {
  id: string;
  companyId: string;
  secretName: string;
  agentId: string | null;
  toolName: string | null;
}

export interface SecretResolution {
  companyId: string;
  agentId: string;
  sessionId?: string | null;
  runId?: string | null;
  toolName: string;
}

/** Reads the master key, creating it on first use. */
export async function loadMasterKey(file: string): Promise<Buffer> {
  try {
    const raw = (await readFile(file, "utf8")).trim();
    const key = Buffer.from(raw, "hex");
    if (key.length !== KEY_BYTES) throw new Error(`master key at ${file} has the wrong length`);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(KEY_BYTES);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, key.toString("hex") + "\n", { mode: 0o600 });
  await chmod(file, 0o600);
  return key;
}

export class SecretCipher {
  constructor(private readonly masterKey: Buffer) {}

  private keyFor(companyId: string): Buffer {
    return Buffer.from(hkdfSync("sha256", this.masterKey, companyId, "opifer/secret/v1", KEY_BYTES));
  }

  encrypt(companyId: string, plaintext: string): { ciphertext: Buffer; nonce: Buffer } {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.keyFor(companyId), nonce);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce };
  }

  decrypt(companyId: string, ciphertext: Buffer, nonce: Buffer): string {
    const body = ciphertext.subarray(0, ciphertext.length - TAG_BYTES);
    const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, this.keyFor(companyId), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  }
}

interface SecretRow {
  id: string;
  name: string;
  version: number;
  ciphertext: Buffer;
  nonce: Buffer;
  created_by: string | null;
  created_at: Date;
}

interface BindingRow {
  id: string;
  company_id: string;
  secret_name: string;
  agent_id: string | null;
  tool_name: string | null;
}

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export class SecretService {
  constructor(
    private readonly sql: Sql,
    private readonly cipher: SecretCipher,
  ) {}

  /** Stores a new version of a secret. The value is never audited. */
  async set(input: { companyId: string; name: string; value: string; actorId?: string | null }): Promise<SecretInfo> {
    if (!NAME_PATTERN.test(input.name)) throw new Error("secret names are upper case identifiers, like OPENAI_API_KEY");
    if (input.value.length === 0) throw new Error("a secret cannot be empty");
    const { ciphertext, nonce } = this.cipher.encrypt(input.companyId, input.value);
    return this.sql.begin(async (tx) => {
      const [row] = await tx<SecretRow[]>`
        INSERT INTO secrets (company_id, name, version, ciphertext, nonce, created_by)
        VALUES (${input.companyId}, ${input.name}, coalesce((SELECT max(version) FROM secrets WHERE company_id = ${input.companyId} AND name = ${input.name}), 0) + 1, ${ciphertext}, ${nonce}, ${input.actorId ?? null})
        RETURNING *
      `;
      await audit(tx, {
        companyId: input.companyId,
        actorKind: "person",
        actorId: input.actorId ?? null,
        action: "secret.set",
        subjectKind: "secret",
        subjectId: row!.id,
        after: { name: row!.name, version: row!.version },
      });
      return { name: row!.name, version: row!.version, createdAt: row!.created_at, createdBy: row!.created_by };
    });
  }

  /** Names and current versions only: values never leave the gateway. */
  async list(companyId: string): Promise<SecretInfo[]> {
    const rows = await this.sql<SecretRow[]>`
      SELECT DISTINCT ON (name) * FROM secrets WHERE company_id = ${companyId} ORDER BY name, version DESC
    `;
    return rows.map((r) => ({ name: r.name, version: r.version, createdAt: r.created_at, createdBy: r.created_by }));
  }

  async remove(companyId: string, name: string, actorId?: string | null): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`DELETE FROM secrets WHERE company_id = ${companyId} AND name = ${name} RETURNING id`;
      if (rows.length === 0) return false;
      await tx`DELETE FROM secret_bindings WHERE company_id = ${companyId} AND secret_name = ${name}`;
      await audit(tx, { companyId, actorKind: "person", actorId: actorId ?? null, action: "secret.removed", subjectKind: "secret", before: { name, versions: rows.length } });
      return true;
    });
  }

  async bind(input: { companyId: string; secretName: string; agentId: string; toolName?: string | null; actorId?: string | null }): Promise<SecretBinding> {
    const [exists] = await this.sql<{ id: string }[]>`SELECT id FROM secrets WHERE company_id = ${input.companyId} AND name = ${input.secretName} LIMIT 1`;
    if (!exists) throw new Error(`secret ${input.secretName} does not exist`);
    const toolName = input.toolName ?? null;
    const [row] = await this.sql<BindingRow[]>`
      INSERT INTO secret_bindings (company_id, secret_name, agent_id, tool_name)
      VALUES (${input.companyId}, ${input.secretName}, ${input.agentId}, ${toolName})
      ON CONFLICT (company_id, secret_name, agent_id, tool_name) DO UPDATE SET updated_at = now()
      RETURNING *
    `;
    await audit(this.sql, {
      companyId: input.companyId,
      actorKind: "person",
      actorId: input.actorId ?? null,
      action: "secret.bound",
      subjectKind: "secret_binding",
      subjectId: row!.id,
      after: { secretName: input.secretName, agentId: input.agentId, toolName },
    });
    return { id: row!.id, companyId: row!.company_id, secretName: row!.secret_name, agentId: row!.agent_id, toolName: row!.tool_name };
  }

  async unbind(companyId: string, bindingId: string, actorId?: string | null): Promise<boolean> {
    const [row] = await this.sql<BindingRow[]>`DELETE FROM secret_bindings WHERE id = ${bindingId} AND company_id = ${companyId} RETURNING *`;
    if (!row) return false;
    await audit(this.sql, {
      companyId,
      actorKind: "person",
      actorId: actorId ?? null,
      action: "secret.unbound",
      subjectKind: "secret_binding",
      subjectId: bindingId,
      before: { secretName: row.secret_name, agentId: row.agent_id, toolName: row.tool_name },
    });
    return true;
  }

  async listBindings(companyId: string, agentId?: string | null): Promise<SecretBinding[]> {
    const agentFilter = agentId ? this.sql`AND agent_id = ${agentId}` : this.sql``;
    const rows = await this.sql<BindingRow[]>`SELECT * FROM secret_bindings WHERE company_id = ${companyId} ${agentFilter} ORDER BY secret_name, tool_name`;
    return rows.map((r) => ({ id: r.id, companyId: r.company_id, secretName: r.secret_name, agentId: r.agent_id, toolName: r.tool_name }));
  }

  /**
   * Decrypted values of the secrets bound to an agent for a tool, as an
   * environment map. Each resolution leaves a secret_access_events row.
   */
  async resolveFor(resolution: SecretResolution): Promise<Record<string, string>> {
    const rows = await this.sql<SecretRow[]>`
      SELECT DISTINCT ON (s.name) s.* FROM secrets s
      JOIN secret_bindings b ON b.company_id = s.company_id AND b.secret_name = s.name
      WHERE s.company_id = ${resolution.companyId}
        AND b.agent_id = ${resolution.agentId}
        AND (b.tool_name IS NULL OR b.tool_name = ${resolution.toolName})
      ORDER BY s.name, s.version DESC
    `;
    const values: Record<string, string> = {};
    for (const row of rows) {
      values[row.name] = this.cipher.decrypt(resolution.companyId, Buffer.from(row.ciphertext), Buffer.from(row.nonce));
    }
    if (rows.length > 0) {
      await this.sql`
        INSERT INTO secret_access_events (company_id, secret_name, agent_id, session_id, run_id, tool_name)
        SELECT ${resolution.companyId}, name, ${resolution.agentId}, ${resolution.sessionId ?? null}, ${resolution.runId ?? null}, ${resolution.toolName}
        FROM unnest(${rows.map((r) => r.name)}::text[]) AS name
      `;
    }
    return values;
  }

  /** A company secret for the system itself (a bot token, a connection key): no agent, access logged under the purpose. */
  async readForSystem(companyId: string, name: string, purpose: string): Promise<string | null> {
    const [row] = await this.sql<SecretRow[]>`SELECT * FROM secrets WHERE company_id = ${companyId} AND name = ${name} ORDER BY version DESC LIMIT 1`;
    if (!row) return null;
    await this
      .sql`INSERT INTO secret_access_events (company_id, secret_name, agent_id, session_id, run_id, tool_name) VALUES (${companyId}, ${name}, NULL, NULL, NULL, ${purpose})`;
    return this.cipher.decrypt(companyId, Buffer.from(row.ciphertext), Buffer.from(row.nonce));
  }

  async accessLog(
    companyId: string,
    limit = 100,
  ): Promise<Array<{ secretName: string; agentId: string | null; sessionId: string | null; runId: string | null; toolName: string | null; occurredAt: Date }>> {
    const rows = await this.sql<{ secret_name: string; agent_id: string | null; session_id: string | null; run_id: string | null; tool_name: string | null; occurred_at: Date }[]>`
      SELECT secret_name, agent_id, session_id, run_id, tool_name, occurred_at FROM secret_access_events WHERE company_id = ${companyId} ORDER BY occurred_at DESC LIMIT ${limit}
    `;
    return rows.map((r) => ({ secretName: r.secret_name, agentId: r.agent_id, sessionId: r.session_id, runId: r.run_id, toolName: r.tool_name, occurredAt: r.occurred_at }));
  }
}
