/**
 * ChatGPT subscription credentials: the OAuth tokens obtained by signing in
 * with a ChatGPT account (Plus, Pro, Team, Enterprise) instead of an API key.
 *
 * Storage is pluggable: the CLI keeps them in a 0600 file under the Opifer
 * home; from M2 they move into the encrypted secrets vault.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ChatGPTCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** ChatGPT account the tokens belong to (sent as `chatgpt-account-id`). */
  accountId: string;
  /** Plan type from the token claims, e.g. plus, pro, team, enterprise, free. */
  planType: string | null;
  email: string | null;
  /** Unix epoch milliseconds when the access token expires. */
  expiresAt: number;
  obtainedAt: number;
}

export interface CredentialStore {
  load(): Promise<ChatGPTCredentials | null>;
  save(credentials: ChatGPTCredentials): Promise<void>;
  clear(): Promise<void>;
}

/** JSON file with owner-only permissions. */
export class FileCredentialStore implements CredentialStore {
  constructor(readonly file: string) {}

  async load(): Promise<ChatGPTCredentials | null> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<ChatGPTCredentials>;
      if (!parsed.accessToken || !parsed.refreshToken || !parsed.accountId) return null;
      return parsed as ChatGPTCredentials;
    } catch {
      return null;
    }
  }

  async save(credentials: ChatGPTCredentials): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify(credentials, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(this.file, 0o600);
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

/** In-memory store, for tests and short-lived processes. */
export class MemoryCredentialStore implements CredentialStore {
  constructor(private credentials: ChatGPTCredentials | null = null) {}

  async load(): Promise<ChatGPTCredentials | null> {
    return this.credentials;
  }

  async save(credentials: ChatGPTCredentials): Promise<void> {
    this.credentials = credentials;
  }

  async clear(): Promise<void> {
    this.credentials = null;
  }
}
