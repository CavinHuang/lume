import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendRunForTest } from "./automation-runner-service";

// #615① 回归钉死:runs.jsonl 写失败必须被 appendRun 吞掉——executeJob 的
// 三处调用方全是 void 发射无 catch,reject 即 unhandledRejection 且 then 链
// (refreshAutomationRunnerJobs/合并触发器)断裂。

describe("automation appendRun 写失败降级 (#615①)", () => {
  test("runs 文件路径为目录(EISDIR)时不抛出", () => {
    const configDir = mkdtempSync(join(tmpdir(), "lume-auto-persist-"));
    const previous = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = configDir;
    try {
      // 把 runs/all.jsonl 替换为目录:appendFileSync 必抛 EISDIR
      const allJsonl = join(configDir, "automation", "runs", "all.jsonl");
      mkdirSync(allJsonl, { recursive: true });

      expect(() => appendRunForTest({
        id: "run-1",
        jobId: "job-1",
        jobName: "n",
        trigger: "schedule",
        status: "success",
        message: "",
        startedAt: 1,
        finishedAt: 2
      })).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.LUME_CONFIG_DIR;
      else process.env.LUME_CONFIG_DIR = previous;
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
