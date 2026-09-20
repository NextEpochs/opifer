/**
 * Interface preferences per person: view mode, theme, language, board
 * layouts. Local mode has one person (user_id null); authenticated mode will
 * key them by the signed-in user.
 */

import type { FastifyInstance } from "fastify";

const KEY = /^[a-z][a-z0-9_.-]{0,80}$/i;

export async function registerPreferenceRoutes(app: FastifyInstance): Promise<void> {
  const { sql } = app.opifer.db;

  app.get("/preferences", async () => {
    const rows = await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM user_preferences WHERE user_id IS NULL`;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });

  app.put<{ Params: { key: string }; Body: { value: unknown } }>("/preferences/:key", async (request, reply) => {
    const key = request.params.key;
    if (!KEY.test(key)) return reply.code(400).send({ error: "bad preference key" });
    const value = (request.body as { value?: unknown } | undefined)?.value;
    if (value === undefined) return reply.code(400).send({ error: "a value is required" });
    if (JSON.stringify(value).length > 20_000) return reply.code(413).send({ error: "preference too large" });
    await sql`INSERT INTO user_preferences (user_id, key, value) VALUES (NULL, ${key}, ${value as never}::jsonb)
      ON CONFLICT (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), key) DO UPDATE SET value = EXCLUDED.value`;
    return { key, value };
  });

  app.delete<{ Params: { key: string } }>("/preferences/:key", async (request) => {
    await sql`DELETE FROM user_preferences WHERE user_id IS NULL AND key = ${request.params.key}`;
    return { key: request.params.key, removed: true };
  });
}
