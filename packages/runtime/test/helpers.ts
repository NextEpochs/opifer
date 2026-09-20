import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "@opifer/db/testing";
import { AgentRuntime, NATIVE_TOOLS, NativeToolExecutor, ProviderRegistry, type RuntimeOptions } from "../src/index.js";
import { FakeProvider, type Script } from "../src/testing.js";

export interface Fixture {
  db: TestDatabase;
  companyId: string;
  agentId: string;
  workRoot: string;
  provider: FakeProvider;
  runtime: AgentRuntime;
  /** Un nuovo runtime sullo stesso database: simula un riavvio del processo. */
  restart(script?: Script, overrides?: Partial<RuntimeOptions>): AgentRuntime;
  destroy(): Promise<void>;
}

export async function createFixture(script: Script, options: Partial<RuntimeOptions> = {}): Promise<Fixture> {
  const db = await createTestDatabase();
  const [company] = await db.sql<{ id: string }[]>`INSERT INTO companies (name, mission) VALUES ('Azienda di prova', 'Provare il runtime') RETURNING id`;
  const [agent] = await db.sql<{ id: string }[]>`
    INSERT INTO agents (company_id, name, role, model) VALUES (${company!.id}, 'Assistente', 'aiuta nei test', 'finto/eco') RETURNING id
  `;
  const workRoot = await mkdtemp(path.join(tmpdir(), "opifer-work-"));
  const provider = new FakeProvider(script);

  const build = (p: FakeProvider, overrides: Partial<RuntimeOptions> = {}) =>
    new AgentRuntime({
      sql: db.sql,
      providers: new ProviderRegistry().register(p),
      tools: new NativeToolExecutor(NATIVE_TOOLS),
      workRoot,
      defaultModel: "finto/eco",
      recovery: { maxAttempts: 3, baseDelayMs: 1 },
      ...options,
      ...overrides,
    });

  return {
    db,
    companyId: company!.id,
    agentId: agent!.id,
    workRoot,
    provider,
    runtime: build(provider),
    restart: (nextScript, overrides) => build(nextScript ? new FakeProvider(nextScript) : provider, overrides),
    destroy: () => db.destroy(),
  };
}
