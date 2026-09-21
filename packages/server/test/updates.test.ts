import { describe, expect, it } from "vitest";
import { UpdateCheck, compareVersions, fetchLatestVersion, type Fetcher } from "../src/updates.js";

const registry =
  (version: string | null, ok = true): Fetcher =>
  async () => ({ ok, json: async () => (version ? { version } : {}) });

describe("update check", () => {
  it("compares versions numerically, ignoring a v prefix and pre-release tags", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("v1.1.2", "1.1.2")).toBe(0);
    expect(compareVersions("1.1.2-beta", "1.1.2")).toBe(0);
    expect(compareVersions("1.1", "1.1.1")).toBeLessThan(0);
  });

  it("reads the latest version from the registry and tolerates a bad answer", async () => {
    expect(await fetchLatestVersion(registry("1.3.0"))).toBe("1.3.0");
    expect(await fetchLatestVersion(registry(null))).toBeNull();
    expect(await fetchLatestVersion(registry("1.3.0", false))).toBeNull();
    expect(
      await fetchLatestVersion(async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });

  it("says when a newer version is out, keeps the last good answer, and stays quiet when disabled", async () => {
    const check = new UpdateCheck("1.1.2", { fetcher: registry("1.2.0") });
    expect(check.status()).toMatchObject({ current: "1.1.2", latest: null, available: false });
    expect(await check.refresh()).toMatchObject({ latest: "1.2.0", available: true });
    const offline = new UpdateCheck("1.2.0", {
      fetcher: async () => {
        throw new Error("offline");
      },
    });
    expect(await offline.refresh()).toMatchObject({ latest: null, available: false });
    const disabled = new UpdateCheck("1.1.2", { enabled: false, fetcher: registry("9.9.9") });
    expect(await disabled.refresh()).toBeNull();
    expect(disabled.status()).toBeNull();
  });
});
