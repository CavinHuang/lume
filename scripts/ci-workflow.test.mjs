import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const workflowPath = resolve(repoRoot, ".github", "workflows", "ci.yml");
const legacyComputerUsePath = resolve(repoRoot, ".github", "workflows", "computer-use.yml");
const workflow = readFileSync(workflowPath, "utf8");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const bunVersion = packageJson.packageManager.split("@").at(-1);
// 只看活跃(非注释)行:断言注释里的历史命令文本会产生假阳性(#780 后 core/windows
// job 整块注释,旧断言 toContain 注释文本依旧绿——测试过了≠测到了)
const activeWorkflow = workflow
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

describe("PR verification workflow contract", () => {
  test("runs PRs once and keeps only the main push verification", () => {
    expect(workflow).toMatch(/^\s*pull_request:\s*$/m);
    expect(workflow).toMatch(/^\s*push:\s*\n\s*branches:\s*\n\s*- main\s*$/m);
    expect(workflow).not.toContain('"codex/**"');
    expect(existsSync(legacyComputerUsePath)).toBe(false);
    expect(workflow).toContain("group: pr-verification-${{ github.event.pull_request.number || github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
  });

  test("pins every Bun runner to the repository package manager", () => {
    const configuredVersions = [...activeWorkflow.matchAll(/bun-version:\s*([^\s]+)/g)].map((match) => match[1]);
    expect(configuredVersions).toHaveLength(2);
    expect(new Set(configuredVersions)).toEqual(new Set([bunVersion]));
    expect(activeWorkflow.match(/bun install --frozen-lockfile/g)).toHaveLength(2);
  });

  test("keeps the active platform checkpoints and their full commands", () => {
    expect(activeWorkflow).toContain("name: macOS desktop reliability");
    expect(activeWorkflow).toContain("bun run --filter @lume/desktop typecheck");
    expect(activeWorkflow).toContain("bun run --filter @lume/desktop test:smoke");
    expect(activeWorkflow).toContain("bun run --filter @lume/agent-sdk test:smoke");
  });

  test("keeps the native-backed permissions and tooling checkpoint (#838①)", () => {
    expect(activeWorkflow).toContain("name: Native-backed permissions and tooling tests (Ubuntu)");
    expect(activeWorkflow).toContain("run: bun run --filter @lume/natives build");
    // analyzeBashCommand(tree-sitter)依赖的 skipIf(!isNativeAvailable()) 门控套件
    // 必须在 natives 构建后的 job 内真实执行
    for (const gatedTest of [
      "packages/sdk/src/tools/bash.test.ts",
      "packages/sdk/src/utils/shell-read-only.test.ts",
      "packages/sdk/src/utils/tokens.test.ts",
      "packages/natives/native-loader.test.ts",
      "apps/sidecar/src/services/agent-runtime/ps-dangerous-verbs.test.ts",
      "apps/sidecar/src/services/agent-runtime/permissions/permission-engine.test.ts",
    ]) {
      expect(activeWorkflow).toContain(gatedTest);
    }
  });

  test("keeps Windows filesystem and sandbox regressions in the native checkpoint", () => {
    const windowsTests = packageJson.scripts["test:windows"];
    expect(windowsTests).toContain("packages/sdk/src/tools/worktree-tools.test.ts");
    expect(windowsTests).toContain("packages/sdk/src/utils/process-sandbox.test.ts");
  });

  test("publishes one stable gate only after every checkpoint succeeds", () => {
    expect(activeWorkflow).toContain("name: PR gate");
    expect(activeWorkflow).toContain("if: always()");
    expect(activeWorkflow).toContain("needs: [macos, natives]");
    expect(activeWorkflow).toContain('test "$MACOS_RESULT" = "success"');
    expect(activeWorkflow).toContain('test "$NATIVES_RESULT" = "success"');
  });
});
