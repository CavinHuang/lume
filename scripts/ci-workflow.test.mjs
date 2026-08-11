import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const workflowPath = resolve(repoRoot, ".github", "workflows", "ci.yml");
const legacyComputerUsePath = resolve(repoRoot, ".github", "workflows", "computer-use.yml");
const workflow = readFileSync(workflowPath, "utf8");
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const bunVersion = packageJson.packageManager.split("@").at(-1);

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
    const configuredVersions = [...workflow.matchAll(/bun-version:\s*([^\s]+)/g)].map((match) => match[1]);
    expect(configuredVersions).toHaveLength(4);
    expect(new Set(configuredVersions)).toEqual(new Set([bunVersion]));
    expect(workflow.match(/bun install --frozen-lockfile/g)).toHaveLength(4);
  });

  test("keeps all five platform checkpoints and their full commands", () => {
    expect(workflow).toContain("name: Core verification (Ubuntu)");
    expect(workflow).toContain("run: bun run typecheck");
    expect(workflow).toContain("run: bun run test:core");
    expect(workflow).toContain("run: bun run test:smoke");

    expect(workflow).toContain("name: Windows reliability");
    expect(workflow).toContain("run: bun run test:windows");

    expect(workflow).toContain("name: macOS desktop reliability");
    expect(workflow).toContain("run: bun apps/desktop/scripts/build-agent-island-native.ts");
    expect(workflow).toContain("bun run --filter @lume/desktop typecheck");
    expect(workflow).toContain("bun run --filter @lume/desktop test:smoke");
    expect(workflow).toContain("bun run --filter @lume/agent-sdk test:smoke");

    expect(workflow).toContain("name: Computer Use (${{ matrix.os }})");
    expect(workflow).toContain("os: [windows-latest, macos-15]");
    expect(workflow).toContain("run: bun run verify:computer-use");
    expect(workflow).toContain("run: bun scripts/build-desktop-host-resources.mjs");
  });

  test("keeps Windows filesystem and sandbox regressions in the native checkpoint", () => {
    const windowsTests = packageJson.scripts["test:windows"];
    expect(windowsTests).toContain("packages/sdk/src/plugins/manager.test.ts");
    expect(windowsTests).toContain("packages/sdk/src/tools/worktree-tools.test.ts");
    expect(windowsTests).toContain("packages/sdk/src/utils/process-sandbox.test.ts");
  });

  test("publishes one stable gate only after every checkpoint succeeds", () => {
    expect(workflow).toContain("name: PR gate");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("needs: [core, windows, macos, computer_use]");
    expect(workflow).toContain('test "$CORE_RESULT" = "success"');
    expect(workflow).toContain('test "$WINDOWS_RESULT" = "success"');
    expect(workflow).toContain('test "$MACOS_RESULT" = "success"');
    expect(workflow).toContain('test "$COMPUTER_USE_RESULT" = "success"');
  });
});
