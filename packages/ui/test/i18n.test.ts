import { describe, expect, it } from "vitest";
import { plural, stringsFor } from "../src/i18n.js";

/** Every key exists in both languages with the same shape, and no Italian string is a bare English leftover. */
function keysOf(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => keysOf(v, prefix ? `${prefix}.${k}` : k));
  return [prefix];
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

function get(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), value);
}

describe("interface strings", () => {
  const en = stringsFor("en");
  const ita = stringsFor("it");

  it("English and Italian have exactly the same keys", () => {
    const enKeys = keysOf(en).sort();
    const itKeys = keysOf(ita).sort();
    expect(itKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !itKeys.includes(k))).toEqual([]);
  });

  it("every placeholder in English appears in Italian too", () => {
    const wrong: string[] = [];
    for (const key of keysOf(en)) {
      const a = get(en, key);
      const b = get(ita, key);
      if (typeof a === "string" && typeof b === "string" && placeholders(a).join() !== placeholders(b).join()) wrong.push(key);
    }
    expect(wrong).toEqual([]);
  });

  it("Italian strings are translated (not identical to English), except identifiers and shared words", () => {
    // Job descriptions stay in English (they become DB values and prompt text); the other words are the same in Italian.
    const allowed = new Set([
      "email",
      "password",
      "comingSoon",
      "botUser",
      "connUrl",
      "subUrl",
      "routineTaskMode",
      "summary",
      "signatureHint",
      "every",
      "tabs.budget",
      "perm.automatic",
      "server",
      "database",
      "scheduleText.cron",
      "roles.writer.name",
    ]);
    const same: string[] = [];
    for (const key of keysOf(en)) {
      const a = get(en, key);
      const b = get(ita, key);
      if (typeof a !== "string" || a.length < 4 || allowed.has(key) || /^roles\.\w+\.role$/.test(key)) continue;
      if (/^[A-Z_]+$|^\W|^[a-z_]+\.[a-z_]+$/.test(a)) continue;
      if (
        a === b &&
        /[a-z]{4,}/i.test(a) &&
        !/^(Telegram|Email|Slack|Docker|Inbox|Chat|Home|Team|Cron|Webhook|Token|URL|JSON|Skill|Skills|Bot|Zapier|Make|n8n|MCP|Routine)$/i.test(a)
      )
        same.push(key);
    }
    expect(same).toEqual([]);
  });

  it("plurals pick the right form per language", () => {
    expect(plural("{n} agent|agents", 1, "en")).toBe("1 agent");
    expect(plural("{n} agent|agents", 3, "en")).toBe("3 agents");
    expect(plural("{n} agente|agenti", 1, "it")).toBe("1 agente");
    expect(plural("{n} agente|agenti", 0, "it")).toBe("0 agenti");
    expect(plural("{n} decision|decisions waiting for you", 2, "en")).toBe("2 decisions waiting for you");
  });
});
