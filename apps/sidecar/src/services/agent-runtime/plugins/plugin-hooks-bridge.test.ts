import { describe, expect, test } from "bun:test";
import { buildPluginAgentHooks, defaultShellHookSpawner } from "./plugin-hooks-bridge.js";
import type { HookInput, HookOutput } from "@lume/agent-sdk";
import type { PluginPermissionRuntime, SensitiveCheckResult } from "./permission-runtime.js";

function fakeRuntime(decision: SensitiveCheckResult["decision"]): PluginPermissionRuntime {
  return {
    async checkSensitiveCapability(): Promise<SensitiveCheckResult> {
      return { decision, reason: decision === "allow" ? "prior allow" : "no prior approval" };
    },
  } as unknown as PluginPermissionRuntime;
}

/** A fake spawner that records calls + returns a canned HookOutput. */
function recordingSpawner(calls: Array<{ command: string; event: string }>) {
  return async (command: string, input: HookInput): Promise<HookOutput | undefined> => {
    calls.push({ command, event: input.event });
    return { message: `spawned: ${command}` };
  };
}

describe("buildPluginAgentHooks", () => {
  test("produces no hooks for an empty capability list", () => {
    const result = buildPluginAgentHooks({
      capabilities: [],
      runtime: fakeRuntime("allow"),
      workspaceSlug: "ws",
      spawner: recordingSpawner([]),
    });
    expect(result).toEqual({});
  });

  test("converts a shell-command hook into a gate-aware handler entry", async () => {
    const calls: Array<{ command: string; event: string }> = [];
    const result = buildPluginAgentHooks({
      capabilities: [
        { pluginId: "acme", hooks: { Stop: [{ command: "echo stop", matcher: "Bash" }] } },
      ],
      runtime: fakeRuntime("allow"),
      workspaceSlug: "ws",
      spawner: recordingSpawner(calls),
    });

    expect(Object.keys(result)).toEqual(["Stop"]);
    expect(result.Stop!).toHaveLength(1);
    expect(result.Stop![0]?.matcher).toBe("Bash");
    expect(result.Stop![0]?.hooks).toHaveLength(1);

    // Fire the handler — allow → spawner called with the command + event.
    const hookInput: HookInput = { event: "Stop", sessionId: "s1" };
    const out = await result.Stop![0]!.hooks[0]!(hookInput, "", { signal: new AbortController().signal });
    expect(out).toEqual({ message: "spawned: echo stop" });
    expect(calls).toEqual([{ command: "echo stop", event: "Stop" }]);
  });

  test("gate deny → handler does NOT spawn and returns undefined", async () => {
    const calls: Array<{ command: string; event: string }> = [];
    const result = buildPluginAgentHooks({
      capabilities: [
        { pluginId: "acme", hooks: { PreToolUse: [{ command: "echo pre" }] } },
      ],
      runtime: fakeRuntime("deny"),
      workspaceSlug: "ws",
      spawner: recordingSpawner(calls),
    });

    const out = await result.PreToolUse![0]!.hooks[0]!(
      { event: "PreToolUse", toolName: "Bash" },
      "",
      { signal: new AbortController().signal },
    );
    expect(out).toBeUndefined();
    expect(calls).toEqual([]); // spawner never called
  });

  test("gate ask → handler does NOT spawn (Phase 2 ask→block for hooks)", async () => {
    const calls: Array<{ command: string; event: string }> = [];
    const result = buildPluginAgentHooks({
      capabilities: [
        { pluginId: "acme", hooks: { Stop: [{ command: "echo stop" }] } },
      ],
      runtime: fakeRuntime("ask"),
      workspaceSlug: "ws",
      spawner: recordingSpawner(calls),
    });

    const out = await result.Stop![0]!.hooks[0]!(
      { event: "Stop" },
      "",
      { signal: new AbortController().signal },
    );
    expect(out).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("gate key uses '*' when matcher is absent", async () => {
    const calls: Array<{ command: string; event: string }> = [];
    let observedKey = "";
    const runtime = {
      async checkSensitiveCapability(params: { key: string }): Promise<SensitiveCheckResult> {
        observedKey = params.key;
        return { decision: "allow", reason: "ok" };
      },
    } as unknown as PluginPermissionRuntime;
    const result = buildPluginAgentHooks({
      capabilities: [{ pluginId: "acme", hooks: { Stop: [{ command: "echo stop" }] } }],
      runtime,
      workspaceSlug: "ws",
      spawner: recordingSpawner(calls),
    });
    await result.Stop![0]!.hooks[0]!({ event: "Stop" }, "", { signal: new AbortController().signal });
    expect(observedKey).toBe("hook:Stop:*");
  });
});

describe("buildPluginAgentHooks — real spawner integration", () => {
  test("allow-ed shell hook spawns and returns parsed output", async () => {
    const result = buildPluginAgentHooks({
      capabilities: [
        { pluginId: "acme", hooks: { Stop: [{ command: "echo '{\"message\":\"hook ran\"}'" }] } },
      ],
      runtime: fakeRuntime("allow"),
      workspaceSlug: "ws",
      spawner: defaultShellHookSpawner,
    });

    const out = await result.Stop![0]!.hooks[0]!(
      { event: "Stop" },
      "",
      { signal: new AbortController().signal },
    ) as HookOutput | undefined;
    expect(out?.message).toBe("hook ran");
  });

  test("allow-ed shell hook with non-JSON output returns {message}", async () => {
    const result = buildPluginAgentHooks({
      capabilities: [
        { pluginId: "acme", hooks: { Stop: [{ command: "echo plain text" }] } },
      ],
      runtime: fakeRuntime("allow"),
      workspaceSlug: "ws",
      spawner: defaultShellHookSpawner,
    });

    const out = await result.Stop![0]!.hooks[0]!(
      { event: "Stop" },
      "",
      { signal: new AbortController().signal },
    ) as HookOutput | undefined;
    expect(out?.message).toBe("plain text");
  });
});
