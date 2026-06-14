import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@lume/agent-sdk";
import { ToolRuntime } from "./tool-runtime";

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: "object", properties: {} },
    async call() {
      return { type: "tool_result", tool_use_id: "", content: "ok" };
    }
  } as ToolDefinition;
}

describe("ToolRuntime", () => {
  test("build owns descriptor registration and runtime wrapping", () => {
    const result = ToolRuntime.build({
      cwd: "/tmp",
      sessionId: `tool-runtime-${crypto.randomUUID()}`,
      permissionMode: "plan",
      policyInput: {},
      groups: [{
        source: "sdk",
        tools: [makeTool("Read"), makeTool("Write")]
      }]
    });

    expect(result.availableToolNames).toEqual(["Read"]);
    expect(result.descriptorsByCanonicalName.get("read")?.metadata.allowedInPlanMode).toBe(true);
    expect((result.tools[0] as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata).toMatchObject({
      runtimeWrapped: true
    });
  });

  test("resolveCommandPluginSpecs only accepts command manifests", async () => {
    const root = join(tmpdir(), `lume-runtime-plugin-${crypto.randomUUID()}`);
    const good = join(root, ".lume", "plugins", "good");
    const moduleOnly = join(root, ".lume", "plugins", "module-only");
    await mkdir(good, { recursive: true });
    await mkdir(moduleOnly, { recursive: true });
    await writeFile(
      join(good, "plugin.json"),
      JSON.stringify({
        name: "good",
        tools: [{
          name: "echo_payload",
          description: "Echo payload",
          command: "node"
        }],
        entry: "index.js"
      }),
      "utf-8"
    );
    await writeFile(
      join(moduleOnly, "plugin.json"),
      JSON.stringify({
        name: "module-only",
        entry: "index.js"
      }),
      "utf-8"
    );

    const resolved = await ToolRuntime.resolveCommandPluginSpecs({ cwd: root });

    expect(resolved.specs).toContainEqual(expect.objectContaining({
      name: "good",
      kind: "command"
    }));
    expect(resolved.specs).not.toContainEqual(expect.objectContaining({
      name: "module-only",
      kind: "command"
    }));
    // Note: diagnostics are no longer produced by SidecarPluginManager
    // (silent skip instead of diagnostic reporting)
  });
});
