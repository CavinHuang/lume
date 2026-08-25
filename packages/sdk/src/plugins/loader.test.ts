import { mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { describe, expect, test } from "bun:test";
import { buildCommandToolDefinition, findUnsafeCmdArgument } from "./loader.js";
import type { CommandToolContribution } from "./normalized.js";

const contribution: CommandToolContribution = {
  name: "echo",
  command: "node",
  args: ["./tools/echo.mjs"],
  cwd: "./",
  timeoutMs: 5000,
  env: { ECHO_MODE: "plain" },
  inputSchema: { type: "object", properties: { msg: { type: "string" } } },
};

describe("buildCommandToolDefinition", () => {
  test("builds a ToolDefinition with name, schema, and flags", () => {
    const def = buildCommandToolDefinition(contribution, "/plugins/acme");
    expect(def.name).toBe("echo");
    expect(def.description).toBe("echo");
    expect(def.inputSchema).toEqual(contribution.inputSchema);
    expect(def.isReadOnly?.()).toBe(false);
    expect(def.isConcurrencySafe?.()).toBe(false);
    expect(typeof def.call).toBe("function");
  });

  test("uses a default object schema when inputSchema is absent", () => {
    const def = buildCommandToolDefinition(
      { name: "ct", command: "echo" },
      "/plugins/acme",
    );
    expect(def.inputSchema).toEqual({ type: "object", properties: {} });
  });
});

describe("cmd.exe metacharacter audit (#317)", () => {
  test("flags %VAR% expansion, chaining and redirection metacharacters", () => {
    for (const unsafe of [
      "%USERPROFILE%",
      "a & calc",
      "a | calc",
      "a < in.txt",
      "a > out.txt",
      "a ^ b",
      "line1\nline2",
      "line1\rline2",
    ]) {
      expect(findUnsafeCmdArgument([unsafe])).toBe(unsafe);
    }
  });

  test("does not flag plain JSON payloads or ordinary arguments", () => {
    expect(findUnsafeCmdArgument(['{"value":"ok"}'])).toBeUndefined();
    expect(findUnsafeCmdArgument(["--flag", "plain value", "%"])).toBeUndefined();
  });

  test.skipIf(process.platform !== "win32")(
    "command tool call with a metacharacter payload is blocked with a clear error",
    async () => {
      const root = join(tmpdir(), `lume-plugin-cmd-${crypto.randomUUID()}`);
      await mkdir(root, { recursive: true });
      const tool = buildCommandToolDefinition(
        // No .exe/.com extension → cmd.exe route on win32.
        { name: "echo_payload", command: "echo" },
        root,
      );
      const blocked = await tool.call(
        { value: "a & calc" },
        { cwd: root, toolUseId: "cmd-block-1" },
      );
      expect(blocked.is_error).toBe(true);
      expect(String((blocked as { content: string }).content)).toContain("cmd metacharacters");

      const allowed = await tool.call(
        { value: "plain" },
        { cwd: root, toolUseId: "cmd-ok-1" },
      );
      expect(allowed.is_error).toBeUndefined();
    },
  );
});

describe("plugin command tool child env (#201)", () => {
  test("child gets the safe default env plus PLUGIN_INPUT, not host secrets", async () => {
    const root = join(tmpdir(), `lume-plugin-env-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const tool = buildCommandToolDefinition({
      name: "env_probe",
      description: "Probe child env",
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({ canary: process.env.LUME_TEST_SECRET ?? null, hasPath: typeof process.env.PATH === 'string', input: process.env.PLUGIN_INPUT ?? null }))"],
      inputSchema: { type: "object", properties: {} },
    }, root);

    process.env.LUME_TEST_SECRET = "leak-me";
    try {
      const result = await tool.call(
        { value: "ok" },
        { cwd: root, toolUseId: "env-probe-1" },
      );
      const probe = JSON.parse(String((result as { content: unknown }).content));
      expect(probe.canary).toBeNull();
      expect(probe.hasPath).toBe(true);
      expect(probe.input).toBe(JSON.stringify({ value: "ok" }));
    } finally {
      delete process.env.LUME_TEST_SECRET;
    }
  });
});
