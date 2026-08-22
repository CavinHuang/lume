import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as actualFsPromises from "node:fs/promises";

const writeFileMock = mock(async (
  path: Parameters<typeof writeFileSync>[0],
  data: Parameters<typeof writeFileSync>[1],
  options?: Parameters<typeof writeFileSync>[2]
) => {
  writeFileSync(path, data, options);
});
const renameMock = mock(async (...args: Parameters<typeof renameSync>) => {
  renameSync(...args);
});

mock.module("node:fs/promises", () => ({
  ...actualFsPromises,
  writeFile: writeFileMock,
  rename: renameMock
}));

const { getWorkspaceSkillsDir } = await import("../infra/config-paths");
const { saveWorkspaceSkill } = await import("./workspace-skill-editor-service");

function withTempConfigDir(): () => void {
  const previous = process.env.LUME_CONFIG_DIR;
  const next = join(tmpdir(), `lume-workspace-skill-atomic-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  process.env.LUME_CONFIG_DIR = next;
  return () => {
    if (previous === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previous;
    }
    rmSync(next, { recursive: true, force: true });
  };
}

describe("workspace-skill-editor-service atomic writes", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    writeFileMock.mockClear();
    renameMock.mockClear();
  });

  test("saves SKILL.md through a temporary file before renaming it into place", async () => {
    cleanup = withTempConfigDir();

    await saveWorkspaceSkill({
      workspaceSlug: "demo",
      skillSlug: "planner",
      name: "Planner",
      description: "Plans work.",
      prompt: "Plan carefully."
    });

    const skillPath = join(getWorkspaceSkillsDir("demo"), "planner", "SKILL.md");
    const writtenPath = String(writeFileMock.mock.calls[0]?.[0] ?? "");

    expect(writtenPath).not.toBe(skillPath);
    expect(writtenPath).toContain("SKILL.md.");
    expect(writtenPath.endsWith(".tmp")).toBe(true);
    expect(renameMock.mock.calls).toEqual([[writtenPath, skillPath]]);
    expect(readFileSync(skillPath, "utf-8")).toContain("Plan carefully.\n");
    expect(existsSync(writtenPath)).toBe(false);
  });
});
