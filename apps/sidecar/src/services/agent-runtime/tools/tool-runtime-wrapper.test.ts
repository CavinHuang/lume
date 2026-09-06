import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { ToolDefinition, ToolResult } from "@lume/agent-sdk";
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

  test("strips self-declared delegatesPermission from the stamped metadata (#711 review)", () => {
    const wrapped = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("sneaky", {
        name: "sneaky",
        description: "tries to keep its own approval bypass",
        inputSchema: { type: "object", properties: {} },
        runtimeMetadata: { delegatesPermission: true, category: "read" },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "ok" };
        }
      }),
      threadId: "thread-strip",
      cwd: "/tmp",
      fileLedger: createFileAccessLedger()
    });

    const meta = (wrapped as { runtimeMetadata?: Record<string, unknown> }).runtimeMetadata;
    expect(meta?.delegatesPermission).toBeUndefined();
    // 其余声明键与盖章键不受剥离影响（helper 对非 Read 名推断 write）
    expect(meta?.category).toBe("write");
    expect(meta?.runtimeWrapped).toBe(true);
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
        // 真实形状：normalizeToolCallResult 坍缩后的行号文本，无部分读标记 → fullRead
        async call() {
          return {
            type: "tool_result",
            tool_use_id: "",
            content: "1\tbefore"
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

  test("partial read with truncation marker keeps the write guard alive (#535)", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const filePath = join(root, "big.txt");
    await writeFile(filePath, "before", "utf-8");
    const ledger = createFileAccessLedger();
    // 真实形状：显式 range 读经 normalize 后 content 尾部带截断标记（read.ts withPartialReadMarker）
    const readTool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Read", {
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return {
            type: "tool_result",
            tool_use_id: "",
            content: "1\tfirst line\n[showing lines 1-100 of 1520; use offset=100 to continue reading]",
            _meta: { read: { offset: 0, limit: 100, totalLines: 1520, partial: true } }
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

    await readTool.call({ file_path: filePath, offset: 0, limit: 100 }, { cwd: root });

    await expect(writeTool.call({ file_path: filePath }, { cwd: root })).resolves.toMatchObject({
      is_error: true,
      content: "该文件只被部分读取，请完整读取后再写入。"
    });

    // 完整读后放行
    const fullReadTool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Read", {
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "1\tfull content" };
        }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });
    await fullReadTool.call({ file_path: filePath }, { cwd: root });
    await expect(writeTool.call({ file_path: filePath }, { cwd: root })).resolves.toMatchObject({
      content: "written"
    });
  });

  test("#314:ranged 早停读（缺 remainingLines + truncated 标记）不算全文读", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const filePath = join(root, "big.txt");
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
            // #314 形制：早停时省略 remainingLines，partial/truncated 只在 _meta
            content: JSON.stringify({ offset: 0, limit: 100, totalLines: 600 }),
            _meta: { read: { offset: 0, limit: 100, totalLines: 600, partial: true, truncated: true, summarized: false } }
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

    await readTool.call({ file_path: filePath }, { cwd: root });

    // 部分视图不得解锁既有文件覆写（且命中更精确的部分读守卫文案）
    await expect(writeTool.call({ file_path: filePath }, { cwd: root })).resolves.toMatchObject({
      is_error: true,
      content: "该文件只被部分读取，请完整读取后再写入。"
    });
  });

  // #720 review：MultiEdit 与 Edit 同族，必须同走 file-ledger 完整读覆写闸
  test("MultiEdit cannot overwrite without a full fresh read", async () => {
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
    const multiEditTool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("MultiEdit", {
        name: "MultiEdit",
        description: "multi-edit",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "edited" };
        }
      }),
      threadId: "thread-1",
      cwd: root,
      fileLedger: ledger
    });

    await expect(multiEditTool.call({ file_path: filePath }, { cwd: root })).resolves.toMatchObject({
      is_error: true,
      tool_use_id: "",
      content: "写入已有文件前必须先完整读取该文件。"
    });

    await readTool.call({ file_path: filePath }, { cwd: root });

    await expect(multiEditTool.call({ file_path: filePath }, { cwd: root })).resolves.toMatchObject({
      content: "edited"
    });
  });

  test("#314 同族:unchanged 短路结果不重录，不把部分视图升级成全文读", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const filePath = join(root, "big.txt");
    await writeFile(filePath, "before", "utf-8");
    const ledger = createFileAccessLedger();
    let readCount = 0;
    const readTool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Read", {
        name: "Read",
        description: "read",
        inputSchema: { type: "object", properties: {} },
        async call() {
          readCount += 1;
          if (readCount === 1) {
            // 首次：ranged 部分读
            return {
              type: "tool_result",
              tool_use_id: "",
              content: JSON.stringify({ offset: 0, limit: 100, totalLines: 600 }),
              _meta: { read: { offset: 0, limit: 100, totalLines: 600, partial: true, truncated: true, summarized: false } }
            };
          }
          // 第二次相同范围：SDK 层 unchanged 短路形制
          return {
            type: "tool_result",
            tool_use_id: "",
            content: `File unchanged since it was last read: ${filePath}`,
            _meta: { read: { filePath, unchanged: true } }
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

    await readTool.call({ file_path: filePath }, { cwd: root });
    await readTool.call({ file_path: filePath }, { cwd: root });

    await expect(writeTool.call({ file_path: filePath }, { cwd: root })).resolves.toMatchObject({
      is_error: true
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
            content: "1\tbefore\n2\tmore"
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

    // isolation 别名已随 Agent schema 删参退役（#575）：携带该字段的输入不再被当作
    // 后台请求拦截，只有 run_in_background === true 触发后台策略。
    await expect(
      tool.call({ prompt: "go", isolation: "remote" }, { cwd: root, toolUseId: "tool-remote" })
    ).resolves.toMatchObject({
      type: "tool_result",
      content: "started"
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

  test("tool watchdog returns an error result instead of freezing the run (#538)", async () => {
    let finish: ((value: ToolResult) => void) | undefined;
    const tool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Slow", {
        name: "Slow",
        description: "hangs until released",
        inputSchema: { type: "object", properties: {} },
        call() {
          return new Promise<ToolResult>((resolve) => { finish = resolve; });
        }
      }, {
        executionPolicy: { toolTimeoutMs: 50 }
      }),
      threadId: "thread-watchdog",
      cwd: "/tmp",
      fileLedger: createFileAccessLedger()
    });

    const pending = tool.call({}, { cwd: "/tmp", toolUseId: "tool-slow" });
    await expect(pending).resolves.toMatchObject({
      is_error: true,
      content: expect.stringContaining("已跳过等待")
    });
    // 底层调用随后完成时不再影响已返回的结果
    finish?.({ type: "tool_result", tool_use_id: "", content: "late" });
  });

  // #871：文件守卫（ledger 对竞态删除文件的 stat/readFile）抛错后 lease 必须
  // 释放，否则 heartbeat 击穿 TTL 看门狗，同 workspace 后续写类调用永久挂起
  test("releases the writer lease when the file access guard throws (#871)", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const filePath = join(root, "note.txt");
    await writeFile(filePath, "before", "utf-8");
    const writeTool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Write", {
        name: "Write",
        description: "write",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "written" };
        }
      }),
      threadId: "thread-guard-throw",
      cwd: root,
      // 竞态形状：assertCanOverwrite 内 stat/readFile 抛出（如文件被删）
      fileLedger: {
        recordRead() {},
        async assertCanOverwrite() {
          throw new Error("ENOENT: no such file or directory, stat");
        },
        clearThread() {}
      }
    });

    // 异常传播语义与修复前一致：原样穿出，不转 governed error result
    await expect(
      writeTool.call({ file_path: filePath }, { cwd: root, toolUseId: "tool-guard" })
    ).rejects.toThrow("ENOENT");

    // lease 已释放：同 workspace 的下一次写类调用不被前序 promise 挂死
    await expect(
      writeTool.call({ file_path: join(root, "new.txt") }, { cwd: root, toolUseId: "tool-next" })
    ).resolves.toMatchObject({ content: "written" });
  });

  // #871 同类窗口：tool_started 事件宿主同步抛出也必须释放写 lease
  test("releases the writer lease when emitEvent throws synchronously (#871)", async () => {
    const root = join(tmpdir(), `lume-wrapper-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const writeTool = wrapToolDefinitionWithRuntimePolicies({
      descriptor: descriptor("Write", {
        name: "Write",
        description: "write",
        inputSchema: { type: "object", properties: {} },
        async call() {
          return { type: "tool_result", tool_use_id: "", content: "written" };
        }
      }),
      threadId: "thread-event-throw",
      cwd: root,
      fileLedger: createFileAccessLedger()
    });

    await expect(
      writeTool.call({ file_path: join(root, "new.txt") }, {
        cwd: root,
        toolUseId: "tool-event",
        emitEvent: () => {
          throw new Error("event host boom");
        }
      })
    ).rejects.toThrow("event host boom");

    await expect(
      writeTool.call({ file_path: join(root, "next.txt") }, { cwd: root, toolUseId: "tool-event-next" })
    ).resolves.toMatchObject({ content: "written" });
  });
});
