import { afterEach, describe, expect, test } from "bun:test";
import { createHookRegistry, HookRegistry, type HookDefinition, type HookInput } from "./hooks.js";

afterEach(() => {
  // Silence the expected console.error output from failing hook paths.
  console.error = originalConsoleError;
});
const originalConsoleError = console.error;

function silenceConsoleError(): void {
  console.error = () => {};
}

function makeInput(overrides: Partial<HookInput> = {}): HookInput {
  return { event: "PreToolUse", sessionId: "session-1", ...overrides };
}

describe("HookRegistry function handler timeouts", () => {
  test("clears the timeout timer when the handler succeeds", async () => {
    const registry = new HookRegistry();
    registry.register("PreToolUse", {
      handler: async () => ({ message: "done" }),
    });

    const originalSet = globalThis.setTimeout;
    const originalClear = globalThis.clearTimeout;
    const createdHandles: unknown[] = [];
    const clearedHandles: unknown[] = [];
    (globalThis as any).setTimeout = ((fn: any, ms?: number) => {
      const handle = originalSet(fn, ms);
      createdHandles.push(handle);
      return handle;
    }) as typeof setTimeout;
    (globalThis as any).clearTimeout = ((handle: any) => {
      if (handle != null) clearedHandles.push(handle);
      return originalClear(handle);
    }) as typeof clearTimeout;

    try {
      const result = await registry.executeDetailed("PreToolUse", makeInput());
      expect(result.outputs).toEqual([{ message: "done" }]);
    } finally {
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    }

    expect(createdHandles.length).toBeGreaterThan(0);
    for (const handle of createdHandles) {
      expect(clearedHandles).toContain(handle);
    }
  });

  test("times out a hanging handler and reports an error hook_response", async () => {
    silenceConsoleError();
    const registry = new HookRegistry();
    let releaseHandler!: () => void;
    registry.register("PreToolUse", {
      timeout: 20,
      handler: async () => {
        await new Promise<void>((resolve) => {
          releaseHandler = resolve;
        });
        return { message: "too late" };
      },
    });

    const result = await registry.executeDetailed("PreToolUse", makeInput());

    const response = result.events.find(
      (event) => event.subtype === "hook_response",
    );
    expect(response && "outcome" in response ? response.outcome : undefined).toBe("error");
    expect(response && "stderr" in response ? response.stderr : "").toContain("Hook timeout");
    expect(result.outputs).toHaveLength(0);

    // Release the late handler so its defensive noop catch settles quietly.
    releaseHandler();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe("HookRegistry matcher handling", () => {
  function hook(name: string, calls: string[], extra: Partial<HookDefinition> = {}): HookDefinition {
    return {
      ...extra,
      handler: async () => {
        calls.push(name);
        return undefined;
      },
    };
  }

  test("an invalid matcher reports an error event and does not abort remaining hooks", async () => {
    silenceConsoleError();
    const registry = createHookRegistry();
    const calls: string[] = [];
    registry.register("PreToolUse", hook("broken", calls, { matcher: "[unclosed" }));
    registry.register("PreToolUse", hook("read-only", calls, { matcher: "Read|Write" }));
    registry.register("PreToolUse", hook("always", calls));

    const result = await registry.executeDetailed(
      "PreToolUse",
      makeInput({ toolName: "Read" }),
    );

    expect(calls).toEqual(["read-only", "always"]);

    const startedNames = result.events
      .filter((event) => event.subtype === "hook_started")
      .map((event) => event.hook_name);
    expect(startedNames).not.toContain("[unclosed");

    const failure = result.events.find(
      (event) => event.subtype === "hook_response" && event.outcome === "error",
    );
    expect(failure).toBeTruthy();
    expect(failure && "stderr" in failure ? failure.stderr : "").toContain("Invalid matcher");
  });

  test("a valid matcher still filters non-matching tools", async () => {
    const registry = createHookRegistry();
    const calls: string[] = [];
    registry.register("PreToolUse", hook("read-only", calls, { matcher: "Read|Write" }));
    registry.register("PreToolUse", hook("always", calls));

    const result = await registry.executeDetailed(
      "PreToolUse",
      makeInput({ toolName: "Bash" }),
    );

    expect(calls).toEqual(["always"]);
    expect(result.events.filter((event) => event.subtype === "hook_started")).toHaveLength(1);
  });
});
