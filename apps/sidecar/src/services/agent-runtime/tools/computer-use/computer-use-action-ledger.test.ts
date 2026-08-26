import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUseActionLedger } from "./computer-use-action-ledger";

let previousConfigDir: string | undefined;
let tempConfigDir = "";

beforeEach(() => {
  previousConfigDir = process.env.LUME_CONFIG_DIR;
  tempConfigDir = mkdtempSync(join(tmpdir(), "lume-action-ledger-"));
  process.env.LUME_CONFIG_DIR = tempConfigDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
  else process.env.LUME_CONFIG_DIR = previousConfigDir;
  rmSync(tempConfigDir, { recursive: true, force: true });
});

describe("ComputerUseActionLedger", () => {
  test("persists fixed phases without raw typed content", () => {
    const ledger = new ComputerUseActionLedger({ workspaceSlug: "demo", threadId: "thread-1" });
    const entry = ledger.plan({
      action: "type_text",
      window: { id: 42, app: "微信" },
      text: "不能写入账本的消息",
      sensitive: true,
    });
    ledger.confirm(entry.actionId);
    ledger.dispatch(entry.actionId);
    ledger.observe(entry.actionId);
    ledger.verify(entry.actionId);

    const path = join(
      tempConfigDir,
      "agent-workspaces",
      "demo",
      "threads",
      "thread-1",
      "files",
      "computer-use",
      "action-ledger.jsonl",
    );
    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.phase)).toEqual([
      "planned", "confirmed", "dispatched", "observed", "verified",
    ]);
    expect(lines[0].textLength).toBe("不能写入账本的消息".length);
    expect(lines[0].sensitive).toBeTrue();
    expect(readFileSync(path, "utf8")).not.toContain("不能写入账本的消息");

    const restored = new ComputerUseActionLedger({ workspaceSlug: "demo", threadId: "thread-1" });
    expect(restored.get(entry.actionId)?.phase).toBe("verified");
    // restore 后终态条目必须出 activeIds 集：observeWindow 不得对历史 verified
    // 条目重复 verify（会触发非法转换 throw，#711 review）
    expect(restored.observeWindow(entry.window, "", undefined)).toEqual([]);
  });

  test("rejects model-like phase promotion", () => {
    const ledger = new ComputerUseActionLedger({ threadId: "thread-1" });
    const entry = ledger.plan({ action: "click", window: { id: 42, app: "微信" } });
    expect(() => ledger.verify(entry.actionId)).toThrow("planned -> verified");
  });
});
