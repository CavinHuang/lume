import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@lume/agent-sdk";
import { createFileAccessLedger } from "./file-access-ledger";
import { wrapToolDefinitionWithRuntimePolicies } from "./tool-runtime-wrapper";
import type { LumeToolDescriptor, LumeToolMetadata } from "./tool-types";

function descriptor(
  name: string,
  definition: ToolDefinition,
  metadata: Partial<LumeToolMetadata> = {}
): LumeToolDescriptor {
  return {
    name,
    canonicalName: name.toLowerCase(),
    source: "sdk",
    definition,
    metadata: {
      category: name === "Read" ? "read" : "write",
      capability: "filesystem",
      riskLevel: name === "Read" ? "low" : "medium",
      sideEffects: name === "Read" ? "local_read" : "local_write",
      allowedInPlanMode: name === "Read",
      isReadOnly: name === "Read",
      isConcurrencySafe: name === "Read",
      ...metadata
    }
  };
}

describe("wrapToolDefinitionWithRuntimePolicies", () => {
  test("stamps descriptor metadata for later runtime resolution passes", () => {
    const wrapped = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("memory.remember", {
        name: "memory.remember",
        description: "remember",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "ok" };
        }
      }, {
        capability: "memory",
        sideEffects: "external",
        requiresApprovalByDefault: true,
        resultPolicy: { maxChars: 123 }
      }),
      threadId: "thread-1",
      cwd: "/tmp",
      fileLedger: createFileAccessLedger()
    });

    expect((wrapped as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata).toMatchObject({
      runtimeWrapped: true,
      source: "sdk",
      capability: "memory",
      resultPolicy: { maxChars: 123 }
    });
  });

  test("protects existing files until a full fresh read is recorded", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "before", "utf-8");
    const ledger = createFileAccessLedger();
    const readTool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Read", {
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return {
            type: "tool_result",
            tool_use_id: "",
            content: JSON.stringify({ remainingLines: 0 })
          };
        }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });
    const writeTool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Write", {
        name: "Write",
        description: "write",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "written" };
        }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    await expect(writeTool.call({ file_path: filePath }, { cwd: root })).resolves.toMatchObject({
      is_error: true,
      tool_use_id: "",
      content: "写入已有文件前必须先完整读取该文件。"
    });

    await readTool.call({ file_path: filePath }, { cwd: root });

    await expect(writeTool.call({ file_path: filePath }, { cwd: root })).resolves.toMatchObject({
      content: "written"
    });
  });

  test("allows creating new files without a prior read", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const ledger = createFileAccessLedger();
    const writeTool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Write", {
        name: "Write",
        description: "write",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "created" };
        }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    await expect(
      writeTool.call({ file_path: join(root, "new.txt") }, { cwd: root, toolUseId: "tool-new" })
    ).resolves.toMatchObject({
      content: "created"
    });
  });

  test("rejects edits after the file changed since the recorded read", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "before", "utf-8");
    const ledger = createFileAccessLedger();
    const readTool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Read", {
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return {
            type: "tool_result",
            tool_use_id: "",
            content: JSON.stringify({ remainingLines: 0 })
          };
        }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });
    const editTool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Edit", {
        name: "Edit",
        description: "edit",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "edited" };
        }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    await readTool.call({ file_path: filePath }, { cwd: root });
    await writeFile(filePath, "changed elsewhere", "utf-8");

    await expect(
      editTool.call({
        file_path: filePath,
        old_string: "changed",
        new_string: "updated",
        replace_all: true
      }, { cwd: root, toolUseId: "tool-edit" })
    ).resolves.toMatchObject({
      is_error: true,
      tool_use_id: "tool-edit",
      content: "文件在读取后已被修改，请重新读取最新内容后再写入。"
    });
  });

  test("rejects oversized tool input before calling the underlying tool", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const ledger = createFileAccessLedger();
    let calls = 0;
    const writeTool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Write", {
        name: "Write",
        description: "write",
        inputSchema: { type: "object", properties: {} },
        async call() {
          calls++;
          return { type: "tool_result", tool_use_id: "", content: "written" };
        }
      }, {
        payloadPolicy: { maxInputChars: 10 }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    await expect(
      writeTool.call({ content: "01234567890123456789" }, { cwd: root, toolUseId: "tool-1" })
    ).resolves.toMatchObject({
      is_error: true,
      tool_use_id: "tool-1",
      content: "Write 输入超过最大长度 10 字符"
    });
    expect(calls).toBe(0);
  });

  test("preserves image blocks when truncating oversized array content (#600)", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const ledger = createFileAccessLedger();
    const pixels = "A".repeat(60_000);
    const tool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Screenshot", {
        name: "mcp__browser__screenshot",
        description: "shot",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return {
            type: "tool_result",
            tool_use_id: "",
            content: [
              { type: "text", text: JSON.stringify({ ok: true, screenshot_id: "browser-screenshot:x", annotated_refs: Array.from({ length: 200 }, (_, i) => `e${i + 1}`) }) },
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: pixels }, _meta: { persist: false } }
            ],
            _meta: { repeatState: true }
          };
        }
      }, {
        resultPolicy: { maxChars: 1000 }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    const result = await tool.call({}, { cwd: root }) as { content: Array<Record<string, unknown>>; _meta?: unknown };
    expect(Array.isArray(result.content)).toBe(true);
    const textBlocks = result.content.filter((block) => block.type === "text") as Array<{ text: string }>;
    const imageBlocks = result.content.filter((block) => block.type === "image");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]!.text.length).toBeLessThanOrEqual(1200);
    expect(textBlocks[0]!.text).toContain("...(truncated)...");
    expect(imageBlocks).toHaveLength(1);
    expect((imageBlocks[0] as { source?: { data?: string } }).source?.data).toBe(pixels);
    // repeat guard 等顶层 _meta 必须原样保留
    expect(result._meta).toEqual({ repeatState: true });
  });

  test("does not truncate array content whose non-image blocks fit the policy", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const ledger = createFileAccessLedger();
    const pixels = "B".repeat(60_000);
    const originalContent = [
      { type: "text", text: "tiny metadata" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: pixels } }
    ];
    const tool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Screenshot", {
        name: "mcp__browser__screenshot",
        description: "shot",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: originalContent } as never;
        }
      }, {
        resultPolicy: { maxChars: 1000 }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    const result = await tool.call({}, { cwd: root }) as { content: unknown };
    expect(result.content).toEqual(originalContent);
  });

  test("still flattens oversized array content without image blocks", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const ledger = createFileAccessLedger();
    const tool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("List", {
        name: "list_things",
        description: "list",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return {
            type: "tool_result",
            tool_use_id: "",
            content: [{ type: "text", text: "x".repeat(5000) }]
          };
        }
      }, {
        resultPolicy: { maxChars: 100 }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    const result = await tool.call({}, { cwd: root }) as { content: unknown };
    expect(typeof result.content).toBe("string");
    expect(String(result.content).length).toBeLessThanOrEqual(200);
    expect(String(result.content)).toContain("...(truncated)...");
  });

  test("truncates long string output according to result policy", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const ledger = createFileAccessLedger();
    const tool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Read", {
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return {
            type: "tool_result",
            tool_use_id: "",
            content: "abcdefghijklmnopqrstuvwxyz"
          };
        }
      }, {
        resultPolicy: { maxChars: 21 }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    const result = await tool.call({}, { cwd: root });
    expect(result.content).toBe("a\n...(truncated)...\nz");
    expect(String(result.content).length).toBeLessThanOrEqual(21);
  });

  test("truncates object data output according to result policy", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const ledger = createFileAccessLedger();
    const tool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Read", {
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return {
            data: {
              rows: ["abcdefghijklmnopqrstuvwxyz", "0123456789"]
            }
          } as never;
        }
      }, {
        resultPolicy: { maxChars: 30 }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    const result = await tool.call({}, { cwd: root });
    expect((result as unknown as { data?: string }).data).toContain("...(truncated)...");
    expect(String((result as unknown as { data?: string }).data).length).toBeLessThanOrEqual(30);
  });

  test("enforces per-turn call limit", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const ledger = createFileAccessLedger();
    const tool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Read", {
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "ok" };
        }
      }, {
        executionPolicy: { maxCallsPerTurn: 1 }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    await expect(tool.call({}, { cwd: root })).resolves.toMatchObject({ content: "ok" });
    await expect(tool.call({}, { cwd: root, toolUseId: "tool-2" })).resolves.toMatchObject({
      is_error: true,
      tool_use_id: "tool-2",
      content: "Read 超过本轮最大调用次数 1"
    });
  });

  test("blocks background execution when runtime policy disallows it", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const ledger = createFileAccessLedger();
    let calls = 0;
    const tool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Bash", {
        name: "Bash",
        description: "bash",
        inputSchema: { type: "object", properties: {} },
        async call() {
          calls++;
          return { type: "tool_result", tool_use_id: "", content: "started" };
        }
      }, {
        category: "execute",
        capability: "shell",
        riskLevel: "high",
        sideEffects: "process",
        executionPolicy: { allowBackground: false }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    await expect(
      tool.call({ command: "long task", run_in_background: true }, { cwd: root, toolUseId: "tool-bg" })
    ).resolves.toMatchObject({
      is_error: true,
      tool_use_id: "tool-bg",
      content: "Bash 不允许后台执行"
    });
    expect(calls).toBe(0);
  });

  test("blocks remote isolation when background execution is disallowed", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const ledger = createFileAccessLedger();
    const tool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Agent", {
        name: "Agent",
        description: "agent",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "started" };
        }
      }, {
        category: "execute",
        capability: "subagent",
        riskLevel: "medium",
        sideEffects: "process",
        executionPolicy: { allowBackground: false }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    await expect(
      tool.call({ prompt: "go", isolation: "remote" }, { cwd: root, toolUseId: "tool-remote" })
    ).resolves.toMatchObject({
      is_error: true,
      tool_use_id: "tool-remote",
      content: "Agent 不允许后台执行"
    });
  });

  test("emits governed events with input summary", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const ledger = createFileAccessLedger();
    const events: Array<Record<string, unknown>> = [];
    const tool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Read", {
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "tool-1", content: "ok" };
        }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    await tool.call(
      { file_path: "note.txt", token: "secret-value" },
      { cwd: root, toolUseId: "tool-1", emitEvent: (event) => events.push(event as unknown as Record<string, unknown>) }
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      subtype: "tool_started",
      tool_name: "Read",
      tool_use_id: "tool-1",
      input_summary: "{\"file_path\":\"note.txt\",\"token\":\"[redacted]\"}"
    });
    expect(events[1]).toMatchObject({
      subtype: "tool_completed",
      tool_name: "Read",
      tool_use_id: "tool-1",
      is_error: false
    });
  });

  test("does not log Computer Use input text", async () => {
    const events: Array<Record<string, unknown>> = [];
    const definition: ToolDefinition = {
      name: "mcp__computer_use__type_text",
      description: "type text",
      inputSchema: { type: "object", properties: {} },
      async call() {
        return { type: "tool_result", tool_use_id: "tool-1", content: "null" };
      },
    };
    const tool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor(definition.name, definition, { capability: "mcp" }),
      threadId: "thread-1",
      cwd: "/tmp",
      fileLedger: createFileAccessLedger(),
    });

    await tool.call(
      { window: { id: 42, app: "微信" }, text: "private message", value: "secret value" },
      { cwd: "/tmp", toolUseId: "tool-1", emitEvent: (event) => events.push(event as unknown as Record<string, unknown>) },
    );

    expect(events[0]?.input_summary).toBe("{\"window\":{\"id\":42,\"app\":\"微信\"},\"textLength\":15,\"valueLength\":12}");
    expect(JSON.stringify(events)).not.toContain("private message");
    expect(JSON.stringify(events)).not.toContain("secret value");
  });

  test("converts thrown tool errors into governed tool results", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const ledger = createFileAccessLedger();
    const events: Array<Record<string, unknown>> = [];
    const tool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Read", {
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          throw new Error("boom");
        }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    const result = await tool.call(
      {},
      { cwd: root, toolUseId: "tool-1", emitEvent: (event) => events.push(event as unknown as Record<string, unknown>) }
    );

    expect(result).toMatchObject({
      is_error: true,
      tool_use_id: "tool-1",
      content: "Read 执行失败：boom"
    });
    expect(events.at(-1)).toMatchObject({
      subtype: "tool_completed",
      tool_name: "Read",
      tool_use_id: "tool-1",
      is_error: true
    });
  });

  test("keeps the writer lease when a foreground Bash call auto-backgrounds", async () => {
    const root = join(tmpdir(), `lume-wrapper-background-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    let completeBackground: (() => void) | undefined;
    const bash = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Bash", {
        name: "Bash",
        description: "bash",
        inputSchema: { type: "object", properties: {} },
        async call(_input, context) {
          completeBackground = context.onBackgroundTaskCompleted;
          return {
            type: "tool_result",
            tool_use_id: "",
            content: "continuing in background",
            _meta: {
              execution: {
                version: 1,
                durationMs: 0,
                command: "slow mutation",
                terminationReason: "running"
              }
            }
          };
        }
      }),
      threadId: "thread-background",
      cwd: root,
      fileLedger: createFileAccessLedger()
    });
    const write = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Write", {
        name: "Write",
        description: "write",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "written" };
        }
      }),
      threadId: "thread-write",
      cwd: root,
      fileLedger: createFileAccessLedger()
    });

    await bash.call({ command: "slow mutation" }, { cwd: root, toolUseId: "tool-bash" });
    expect(completeBackground).toBeFunction();

    let writeFinished = false;
    const writing = write.call({}, { cwd: root, toolUseId: "tool-write" }).then(() => {
      writeFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writeFinished).toBe(false);

    completeBackground?.();
    await writing;
    expect(writeFinished).toBe(true);
  });
});
