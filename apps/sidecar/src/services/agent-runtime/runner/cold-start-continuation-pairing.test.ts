import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { persistToolApprovalInterruption } from "../interruption/approval-service";
import { getRuntimeCoreSessionDir } from "../runtime-core/session-store";
import { createFileBackedRunContinuationStore } from "../runtime-core/run-continuation-store";
import { stableHashPayload } from "../../infra/payload-hash";

/**
 * 冷启动续跑的写↔读端到端配对钉(#531 复审 M3)：审批中断把
 * checkpoint.toolCall.inputHash 落盘(run-continuation store)，恢复后
 * lume-runner 的 createContinuationPermissionHandler 用 stableHashPayload
 * 独立重算并等值比对——本测试模拟磁盘 JSON 往返，钉住两侧经同一实现配对，
 * 任一侧换序列化/哈希语义即红。
 */
describe("冷启动续跑 toolCall.inputHash 配对(#531 复审 M3)", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-continuation-pairing-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  test("真实持久化的 checkpoint inputHash 与独立重算值在 JSON 往返后仍配对", async () => {
    const input = { command: "ls -la", nested: { keep: 1, quote: '含"引号"与\n换行' } };
    await persistToolApprovalInterruption({
      threadId: "thread-pair",
      requestId: "req-1",
      runId: "run-1",
      toolUseId: "tu_1",
      toolName: "Bash",
      input,
      canAllowAlways: true,
      reason: "pairing"
    });

    // 模拟恢复路径：从盘上读回(进程内对象→JSON→再解析)
    const store = createFileBackedRunContinuationStore(getRuntimeCoreSessionDir("thread-pair"));
    const state = await store.get("run-1");
    expect(state).not.toBeNull();
    const persisted = JSON.parse(JSON.stringify(state)) as {
      checkpoint: { toolCall: { id: string; name: string; input: unknown; inputHash: string } };
    };
    const call = persisted.checkpoint.toolCall;
    expect(call.id).toBe("tu_1");
    expect(call.name).toBe("Bash");
    // 读侧独立重算 == 写侧落盘 hash（跨真实文件 + JSON 往返）
    expect(stableHashPayload(call.input)).toBe(call.inputHash);
    // 反向：被篡改的输入不得配对（防 cold_start_exact_tool_continuation 误放行）
    const tampered = JSON.parse(JSON.stringify(call.input)) as Record<string, unknown>;
    tampered.command = "rm -rf /";
    expect(stableHashPayload(tampered)).not.toBe(call.inputHash);
  });
});
