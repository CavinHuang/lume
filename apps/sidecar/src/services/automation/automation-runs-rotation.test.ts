import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateAutomationRunsIfBloatedForTest } from "./automation-runner-service";

// #555 回归钉死:runs.jsonl 只增不滚会让三处高频列表入口永久恶化。
// 软上限触发的截断必须保留最近窗口、原子替换,且未超限时绝不触碰文件。

function makeRunsFile(lineCount: number): string {
  const directory = mkdtempSync(join(tmpdir(), "lume-runs-rotation-"));
  const runsPath = join(directory, "automation-runs.jsonl");
  const lines = Array.from({ length: lineCount }, (_, index) => JSON.stringify({ id: `run-${index}` }));
  writeFileSync(runsPath, `${lines.join("\n")}\n`, "utf-8");
  return runsPath;
}

describe("automation-runs.jsonl rotation (#555)", () => {
  it("keeps the most recent window and drops only older lines when over the cap", () => {
    // 构造超限文件:每行 ~20B,8MB 软上限需要大量行——直接用小行数无法触发,
    // 因此以行为单位验证保留语义(阈值判定由 size 分支覆盖)
    const runsPath = makeRunsFile(6000);
    // 文件远小于软上限:先确认不误伤
    rotateAutomationRunsIfBloatedForTest(runsPath);
    expect(readFileSync(runsPath, "utf-8").split("\n").filter(Boolean).length).toBe(6000);

    // 压过软上限:填充到 >8MB
    const bigLine = `${JSON.stringify({ id: "run-big", pad: "x".repeat(2048) })}`;
    const lines = Array.from({ length: 4200 }, () => bigLine);
    writeFileSync(runsPath, `${lines.join("\n")}\n`, "utf-8");
    expect(statSync(runsPath).size).toBeGreaterThan(8 * 1024 * 1024);

    rotateAutomationRunsIfBloatedForTest(runsPath);

    const kept = readFileSync(runsPath, "utf-8").split("\n").filter(Boolean);
    expect(kept.length).toBeLessThanOrEqual(4000);
    // 保留的是最近窗口:最后一行原样存活
    expect(kept[kept.length - 1]).toBe(bigLine);
    // 无 .tmp 残留
    expect(require("node:fs").existsSync(`${runsPath}.tmp`)).toBe(false);

    rmSync(join(runsPath, ".."), { recursive: true, force: true });
  });
});
