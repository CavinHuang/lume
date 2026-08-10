import { describe, it, expect } from "bun:test";
import { createSdkImCliTools } from "./create-im-cli-tools";
import { dingtalkCliConfig } from "./providers/dingtalk";
import type { CliExecResult } from "./cli-executor";

const baseInput = {
  config: dingtalkCliConfig,
  userDataRoot: "/u",
  platform: "darwin",
  arch: "arm64",
};

describe("createSdkImCliTools", () => {
  it("产生名为 dingtalk_cli 的工具,含 command/args schema", () => {
    const tools = createSdkImCliTools(baseInput);
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe("dingtalk_cli");
    const schema = tool.inputSchema as unknown as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.command?.type).toBe("string");
    expect(props.args?.type).toBe("array");
    expect(schema.required).toContain("command");
  });

  it("handler 解析 binary 后用 command/args 调 execCli 并返回结构化结果", async () => {
    let captured: { cmd: string; args: string[] } | null = null;
    const tools = createSdkImCliTools({
      ...baseInput,
      overrides: {
        ensureBinary: async () => ({ path: "/fake/dws", downloaded: false }),
        execCli: async (cmd: string, args: string[]): Promise<CliExecResult> => {
          captured = { cmd, args };
          return { ok: true, stdout: '{"ok":true}', stderr: "", exitCode: 0, timedOut: false };
        },
      },
    });
    const ret = await (tools[0] as unknown as { call: (a: unknown, ctx: unknown) => Promise<Record<string, unknown>> }).call(
      { command: "calendar", args: ["list", "--today"] },
      { cwd: "." },
    );
    // defineTool.call 把 handler 返回值标准化成 ToolResult(content 为 JSON 字符串)
    const res = JSON.parse((ret as { content: string }).content);
    expect(captured).not.toBeNull();
    expect((captured as unknown as { cmd: string }).cmd).toBe("/fake/dws");
    expect((captured as unknown as { args: string[] }).args).toEqual(["calendar", "list", "--today"]);
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
  });

  it("未授权(execCli 返回非零且 stderr 含授权提示)时结果含 guidance", async () => {
    const tools = createSdkImCliTools({
      ...baseInput,
      overrides: {
        ensureBinary: async () => ({ path: "/fake/dws", downloaded: false }),
        execCli: async (): Promise<CliExecResult> => ({
          ok: false, stdout: "", stderr: "not logged in", exitCode: 69, timedOut: false,
        }),
      },
    });
    const ret = await (tools[0] as unknown as { call: (a: unknown, ctx: unknown) => Promise<Record<string, unknown>> }).call(
      { command: "auth", args: ["status"] },
      { cwd: "." },
    );
    // defineTool.call 把 handler 返回值标准化成 ToolResult(content 为 JSON 字符串)
    const res = JSON.parse((ret as { content: string }).content);
    expect(res.ok).toBe(false);
    expect(String(res.guidance ?? res.stderr)).toContain("授权");
  });
});
