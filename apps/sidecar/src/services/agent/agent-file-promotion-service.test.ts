import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentSessionWorkspacePath, getAgentThreadFilesPath, getWorkspaceResourcesPath } from "../infra/config-paths";
import { listWorkspaceDirectory, saveFilesToAgentSession } from "./agent-files-service";
import { promoteFileToWorkspace } from "./agent-file-promotion-service";

describe("agent-file-promotion-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-file-promotion-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = prevConfigDir;
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("应将任务文件复制到 resources 并保留原文件", () => {
    const threadFiles = getAgentThreadFilesPath("demo", "thread-1");
    const source = join(threadFiles, "report.md");
    writeFileSync(source, "# report", "utf-8");

    const result = promoteFileToWorkspace({
      workspaceSlug: "demo",
      threadId: "thread-1",
      filePath: source
    });

    expect(result.ok).toBeTrue();
    expect(existsSync(source)).toBeTrue();
    expect(existsSync(join(getWorkspaceResourcesPath("demo"), "report.md"))).toBeTrue();
  });

  test("同名文件存在时默认不应静默覆盖", () => {
    const threadFiles = getAgentThreadFilesPath("demo", "thread-1");
    const source = join(threadFiles, "report.md");
    writeFileSync(source, "# report", "utf-8");
    writeFileSync(join(getWorkspaceResourcesPath("demo"), "report.md"), "# existing", "utf-8");

    expect(() => promoteFileToWorkspace({
      workspaceSlug: "demo",
      threadId: "thread-1",
      filePath: source
    })).toThrow("同名文件已存在");
  });

  test("仅当线程文件本身带外部附加 provenance 时才继承到工作区", () => {
    const externalSource = join(tempConfigDir, "external.md");
    writeFileSync(externalSource, "# external", "utf-8");

    const source = join(getAgentSessionWorkspacePath("demo", "thread-1"), "imported.md");
    saveFilesToAgentSession({
      workspaceSlug: "demo",
      threadId: "thread-1",
      files: [{ filename: "imported.md", sourcePath: externalSource }]
    });

    const promoted = promoteFileToWorkspace({
      workspaceSlug: "demo",
      threadId: "thread-1",
      filePath: source
    });

    expect(promoted.ok).toBeTrue();
    expect(listWorkspaceDirectory("demo").find((entry) => entry.name === "imported.md")?.externalAttachment).toEqual({
      label: "外部附加",
      absoluteSourcePath: externalSource
    });
  });

  test("overwrite 非外部来源文件时应清理旧的工作区 provenance", () => {
    const externalSource = join(tempConfigDir, "external.md");
    writeFileSync(externalSource, "# external", "utf-8");

    saveFilesToAgentSession({
      workspaceSlug: "demo",
      threadId: "thread-1",
      files: [{ filename: "imported.md", sourcePath: externalSource }]
    });
    promoteFileToWorkspace({
      workspaceSlug: "demo",
      threadId: "thread-1",
      filePath: join(getAgentSessionWorkspacePath("demo", "thread-1"), "imported.md")
    });

    saveFilesToAgentSession({
      workspaceSlug: "demo",
      threadId: "thread-1",
      files: [{ filename: "imported.md", data: Buffer.from("# generated").toString("base64") }]
    });
    promoteFileToWorkspace({
      workspaceSlug: "demo",
      threadId: "thread-1",
      filePath: join(getAgentSessionWorkspacePath("demo", "thread-1"), "imported.md"),
      conflictMode: "overwrite"
    });

    expect(listWorkspaceDirectory("demo").find((entry) => entry.name === "imported.md")?.externalAttachment).toBeUndefined();
  });
});
