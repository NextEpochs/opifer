import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatchTool, coderTool, editFileTool } from "../src/tools/code.js";
import type { ToolContext } from "../src/tools/types.js";

async function workdir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "opifer-code-"));
}

function contextFor(dir: string): ToolContext {
  return { sessionId: "s", companyId: "c", agentId: "a", runId: "r", callId: "k", agentRole: "developer", workdir: dir, signal: new AbortController().signal };
}

describe("code tools", () => {
  it("edit_file replaces exactly one occurrence, refuses ambiguity, and replaces all on request", async () => {
    const dir = await workdir();
    await writeFile(path.join(dir, "a.txt"), "one two two three\n");
    const ctx = contextFor(dir);
    expect((await editFileTool.execute({ path: "a.txt", old_string: "one", new_string: "1" }, ctx)).content).toContain("1 replacement");
    const ambiguous = await editFileTool.execute({ path: "a.txt", old_string: "two", new_string: "2" }, ctx);
    expect(ambiguous.isError).toBe(true);
    expect((await editFileTool.execute({ path: "a.txt", old_string: "two", new_string: "2", replace_all: true }, ctx)).content).toContain("2 replacements");
    expect((await editFileTool.execute({ path: "a.txt", old_string: "missing", new_string: "x" }, ctx)).isError).toBe(true);
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("1 2 2 three\n");
  });

  it("apply_patch applies a unified diff and leaves the file alone when it does not apply", async () => {
    const dir = await workdir();
    await writeFile(path.join(dir, "hello.txt"), "hello\nworld\n");
    const ctx = contextFor(dir);
    const patch = "--- a/hello.txt\n+++ b/hello.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+there\n";
    const applied = await applyPatchTool.execute({ patch }, ctx);
    expect(applied.isError, applied.content).toBeFalsy();
    expect(await readFile(path.join(dir, "hello.txt"), "utf8")).toBe("hello\nthere\n");
    const wrong = await applyPatchTool.execute({ patch: "--- a/hello.txt\n+++ b/hello.txt\n@@ -1,2 +1,2 @@\n hello\n-nope\n+x\n" }, ctx);
    expect(wrong.isError).toBe(true);
    expect(await readFile(path.join(dir, "hello.txt"), "utf8")).toBe("hello\nthere\n");
  });

  it("run_coder hands the brief to the coding agent in the working directory and reports its answer", async () => {
    const dir = await workdir();
    // A stand-in for Claude Code: it records the brief, writes a file and answers like `claude -p --output-format json`.
    const fake = path.join(dir, "fake-claude");
    await writeFile(fake, '#!/bin/sh\nprintf "%s" "$2" > brief.txt\necho \'{"result":"Added the greeting.","is_error":false,"total_cost_usd":0.12,"num_turns":3}\'\n');
    await chmod(fake, 0o755);
    const tool = coderTool({ kind: "claude", binary: fake, maxTurns: 5 });
    expect(tool.definition.name).toBe("run_coder");
    expect(tool.risk).toBe("high");
    const out = await tool.execute({ brief: "Add a greeting to README" }, contextFor(dir));
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Claude Code finished");
    expect(out.content).toContain("Added the greeting.");
    expect(out.content).toContain("0.12 USD");
    expect(await readFile(path.join(dir, "brief.txt"), "utf8")).toBe("Add a greeting to README");
    const failing = path.join(dir, "fake-fail");
    await writeFile(failing, '#!/bin/sh\necho \'{"result":"Could not do it","is_error":true}\'\n');
    await chmod(failing, 0o755);
    expect((await coderTool({ kind: "claude", binary: failing }).execute({ brief: "x" }, contextFor(dir))).isError).toBe(true);
  });
});
