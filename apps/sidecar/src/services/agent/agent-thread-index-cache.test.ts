import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentThread,
  getAgentThreadMeta
} from "./agent-thread-manager";
import { getAgentSessionsIndexPath } from "../infra/config-paths";

describe("线程索引读缓存（#170）", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-index-cache-"));
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

  test("readIndex 返回深拷贝：外部 mutate 不污染缓存", () => {
    const created = createAgentThread("原标题");
    // 第一次读填充缓存
    expect(getAgentThreadMeta(created.id)?.title).toBe("原标题");

    // 拿到引用后原地 mutate（模拟调用方误用）
    const mutated = getAgentThreadMeta(created.id) as unknown as { title: string };
    mutated.title = "被污染的标题";

    // 再次读不受影响（缓存对象未被污染）
    expect(getAgentThreadMeta(created.id)?.title).toBe("原标题");
  });

  test("index 文件被外部改写（mtime 变化）后缓存失效", () => {
    const created = createAgentThread("原标题");
    expect(getAgentThreadMeta(created.id)?.title).toBe("原标题");

    // 外部进程改写 index 文件（绕过 writeIndex）
    const indexPath = getAgentSessionsIndexPath();
    const raw = JSON.parse(__readIndexRaw(indexPath)) as { threads: Array<{ id: string; title: string }> };
    for (const thread of raw.threads) {
      if (thread.id === created.id) thread.title = "外部改写";
    }
    writeFileSync(indexPath, JSON.stringify(raw, null, 2), "utf-8");

    expect(getAgentThreadMeta(created.id)?.title).toBe("外部改写");
  });

  test("LUME_CONFIG_DIR 切换目录后缓存不串（path 键失效）", () => {
    const createdA = createAgentThread("目录A线程");
    expect(getAgentThreadMeta(createdA.id)?.title).toBe("目录A线程");

    // 切到全新空目录（模拟测试/多实例场景）
    const dirB = mkdtempSync(join(tmpdir(), "lume-agent-index-cache-b-"));
    process.env.LUME_CONFIG_DIR = dirB;
    try {
      // 不应命中目录A的缓存
      expect(getAgentThreadMeta(createdA.id)).toBeUndefined();
    } finally {
      rmSync(dirB, { recursive: true, force: true });
      process.env.LUME_CONFIG_DIR = tempConfigDir;
    }
  });
});

function __readIndexRaw(path: string): string {
  // 直接读文件绕过缓存
  return require("node:fs").readFileSync(path, "utf-8") as string;
}
