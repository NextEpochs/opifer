import { migrateDown, migrateUp, migrationStatus } from "@opifer/db";
import { openDatabase } from "../database.js";
import { requireConfig, resolveHome } from "../home.js";
import { c, say } from "../output.js";

export async function runMigrate(action: "status" | "up" | "down", options: { home?: string; steps?: string; to?: string }): Promise<void> {
  const home = resolveHome(options.home);
  const config = await requireConfig(home);
  const db = await openDatabase(home, config);
  try {
    const sql = db.handle.sql;
    if (action === "status") {
      const status = await migrationStatus(sql);
      for (const a of status.applied) say.ok(`${String(a.version).padStart(4, "0")}_${a.name} ${c.dim(a.appliedAt.toISOString())}`);
      for (const p of status.pending) say.warn(`${String(p.version).padStart(4, "0")}_${p.name} ${c.dim("in attesa")}`);
      if (status.applied.length === 0 && status.pending.length === 0) say.info("Nessuna migrazione");
      return;
    }
    const to = options.to !== undefined ? Number(options.to) : undefined;
    if (action === "up") {
      const applied = await migrateUp(sql, { log: say.ok, ...(to !== undefined ? { to } : {}) });
      if (applied.length === 0) say.info("Schema già aggiornato");
      return;
    }
    const reverted = await migrateDown(sql, {
      log: say.ok,
      ...(to !== undefined ? { to } : { steps: Number(options.steps ?? 1) }),
    });
    if (reverted.length === 0) say.info("Nulla da ritirare");
  } finally {
    await db.close();
  }
}
