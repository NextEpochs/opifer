import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPIFER_VERSION } from "../src/index.js";

describe("version", () => {
  it("the constant reported by /v1/health is the version of the release", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
    expect(OPIFER_VERSION).toBe(pkg.version);
  });
});
