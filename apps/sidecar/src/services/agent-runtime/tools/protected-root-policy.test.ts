import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ToolDefinition } from "@lume/agent-sdk";
import { evaluateProtectedRootAccess, wrapToolWithProtectedRootPolicy } from "./protected-root-policy";
import type { LumeToolDescriptor } from "./tool-types";

const roots: string[] = [];
function tempRoot(name: string): string {
  const value = mkdtempSync(join(tmpdir(), name));
  roots.push(value);
  return value;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function descriptor(name: string, capability: LumeToolDescriptor["metadata"]["capability"] = "filesystem"): LumeToolDescriptor {
  const definition = {
    name, description: name, inputSchema: { type: "object", properties: {} },
    async call() { return { type: "tool_result" as const, tool_use_id: "", content: "executed" }; },
  } satisfies ToolDefinition;
  return {
    name, canonicalName: name.toLowerCase(), source: capability === "mcp" ? "mcp" : "sdk", definition,
    metadata: {
      category: capability === "shell" ? "execute" : "read", capability,
      riskLevel: "low", sideEffects: "local_read", allowedInPlanMode: true,
      isReadOnly: capability !== "shell", isConcurrencySafe: true,
    },
  };
}

describe("Wiki protected-root policy", () => {
  test("hard-denies direct file tools in every permission mode", async () => {
    const config = tempRoot("lume-protected-"); const workspace = tempRoot("lume-workspace-");
    const wiki = join(config, "wiki"); mkdirSync(wiki);
    let calls = 0;
    const base = descriptor("Read");
    const wrapped = wrapToolWithProtectedRootPolicy({
      descriptor: base,
      tool: { ...base.definition, async call() { calls += 1; return { type: "tool_result", tool_use_id: "", content: "executed" }; } },
      cwd: workspace, protectedRoots: [wiki],
    });
    for (const permissionMode of ["default", "acceptEdits", "dontAsk", "bypassPermissions"] as const) {
      const result = await wrapped.call({ file_path: join(wiki, "secret.md") }, { cwd: workspace, permissionMode });
      expect(result.is_error).toBe(true);
    }
    expect(calls).toBe(0);
  });

  test("canonicalizes a workspace junction before checking containment", () => {
    const config = tempRoot("lume-protected-"); const workspace = tempRoot("lume-workspace-");
    const wiki = join(config, "wiki"); mkdirSync(wiki);
    const alias = join(workspace, "knowledge");
    symlinkSync(wiki, alias, process.platform === "win32" ? "junction" : "dir");
    expect(evaluateProtectedRootAccess({
      descriptor: descriptor("Read"), rawInput: { path: join(alias, "page.md") }, cwd: workspace, protectedRoots: [wiki],
    })).toMatchObject({ reasonCode: "protected_root" });
  });

  test("blocks explicit Wiki paths in shell and MCP payloads but allows unrelated files", () => {
    const config = tempRoot("lume-protected-"); const workspace = tempRoot("lume-workspace-");
    const wiki = join(config, "wiki"); mkdirSync(wiki);
    expect(evaluateProtectedRootAccess({
      descriptor: descriptor("Bash", "shell"), rawInput: { command: `type ${join(wiki, "page.md")}` }, cwd: workspace, protectedRoots: [wiki],
    })?.reasonCode).toBe("protected_root");
    expect(evaluateProtectedRootAccess({
      descriptor: descriptor("node_repl", "shell"), rawInput: { code: `readFileSync(${JSON.stringify(join(wiki, "page.md"))})` }, cwd: workspace, protectedRoots: [wiki],
    })?.reasonCode).toBe("protected_root");
    expect(evaluateProtectedRootAccess({
      descriptor: descriptor("mcp__filesystem__read", "mcp"), rawInput: { filePath: join(wiki, "page.md") }, cwd: workspace, protectedRoots: [wiki],
    })?.reasonCode).toBe("protected_root");
    expect(evaluateProtectedRootAccess({
      descriptor: descriptor("mcp__filesystem__read", "mcp"), rawInput: { destinationPath: join("..", basename(config), "wiki", "page.md") }, cwd: workspace, protectedRoots: [wiki],
    })?.reasonCode).toBe("protected_root");
    expect(evaluateProtectedRootAccess({
      descriptor: descriptor("Read"), rawInput: { file_path: join(workspace, "README.md") }, cwd: workspace, protectedRoots: [wiki],
    })).toBeNull();
  });

  test("allows only dedicated Wiki capabilities when cwd itself is protected", () => {
    const config = tempRoot("lume-protected-"); const wiki = join(config, "wiki"); mkdirSync(wiki);
    expect(evaluateProtectedRootAccess({ descriptor: descriptor("Read"), rawInput: {}, cwd: wiki, protectedRoots: [wiki] })).not.toBeNull();
    expect(evaluateProtectedRootAccess({ descriptor: descriptor("wiki.search"), rawInput: { query: "x" }, cwd: wiki, protectedRoots: [wiki] })).toBeNull();
    expect(evaluateProtectedRootAccess({ descriptor: descriptor("wiki.plugin_escape"), rawInput: {}, cwd: wiki, protectedRoots: [wiki] })).not.toBeNull();
  });
});
