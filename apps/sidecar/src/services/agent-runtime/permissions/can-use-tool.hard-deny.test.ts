import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanUseToolHandler } from "./can-use-tool";

/**
 * §8.2 hard deny wiring (#345): tools.deny declared by a plugin's permissions
 * blocks its own tools unconditionally — including under bypassPermissions.
 */
describe("createCanUseToolHandler plugin hard deny (#345)", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-can-use-tool-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  function makeHandler(
    pluginInterceptorContexts: Array<{
      pluginName: string;
      pluginRoot: string;
      permissions: Record<string, unknown>;
    }>,
  ) {
    return createCanUseToolHandler(
      {
        input: { threadId: "thread-hard-deny", permissionMode: "bypassPermissions", userMessage: "任务" },
        runtime: { sessionId: "thread-hard-deny" },
      } as never,
      { workspaceSlug: undefined, agentCwd: "/tmp" } as never,
      { onRuntimeEvent: () => undefined, onToolPermissionRequest: () => undefined } as never,
      new AbortController().signal,
      "run-hard-deny",
      undefined,
      pluginInterceptorContexts,
    );
  }

  test("denies a hard-denied plugin tool even under bypassPermissions (#345)", async () => {
    const handler = makeHandler([
      {
        pluginName: "acme",
        pluginRoot: "/plugins/acme",
        permissions: { tools: { deny: ["Bash"] } },
      },
    ]);

    const result = await handler(
      { name: "Bash", runtimeMetadata: { pluginId: "acme" } } as never,
      { command: "echo hi" },
      { toolUseId: "tool-hd-1" },
    );

    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("hard-denied");
    expect(result.message).toContain("acme");
  });

  test("does not hard-deny a plugin tool outside the deny list (#345)", async () => {
    const handler = makeHandler([
      {
        pluginName: "acme",
        pluginRoot: "/plugins/acme",
        permissions: { tools: { deny: ["Write"] } },
      },
    ]);

    const result = await handler(
      { name: "Read", runtimeMetadata: { pluginId: "acme" } } as never,
      { file_path: "/tmp/x.txt" },
      { toolUseId: "tool-hd-2" },
    );

    // Flow continues past the hard-deny gate (unit harness denies later at
    // descriptor lookup) — the assertion pins that the denial reason is not
    // the plugin hard-deny.
    expect(String(result.message)).not.toContain("hard-denied");
  });

  test("leaves built-in tools without a source plugin untouched (#345)", async () => {
    const handler = makeHandler([
      {
        pluginName: "acme",
        pluginRoot: "/plugins/acme",
        permissions: { tools: { deny: ["Bash"] } },
      },
    ]);

    const result = await handler(
      { name: "Bash" } as never,
      { command: "echo hi" },
      { toolUseId: "tool-hd-3" },
    );

    // Source binding: no runtimeMetadata.pluginId → plugin deny lists don't apply.
    expect(String(result.message)).not.toContain("hard-denied");
  });
});
