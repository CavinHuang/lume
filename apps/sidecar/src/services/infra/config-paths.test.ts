import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  getAgentThreadArtifactsPath,
  getAgentThreadFilesPath,
  getAgentThreadRootPath,
  getAgentThreadSystemContextPath,
  getConfigDir,
  getGlobalMemoryDbPath,
  getGlobalMemoryPath,
  getLumeConfigAuditPath,
  getLumeConfigYamlPath,
  getWorkspaceMetaPath,
  getWorkspaceLongTermMemoryPath,
  getWorkspaceResourcesPath
} from "./config-paths";

describe("config-paths", () => {
  const prevConfigDir = process.env.LUME_CONFIG_DIR;
  const created: string[] = [];

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("getConfigDir 应优先使用 LUME_CONFIG_DIR（绝对路径）", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-config-paths-"));
    created.push(dir);
    process.env.LUME_CONFIG_DIR = dir;

    expect(getConfigDir()).toBe(dir);
  });

  test("getConfigDir 应支持 LUME_CONFIG_DIR 相对路径并解析为绝对路径", () => {
    const rel = `.tmp-lume-config-${Date.now()}`;
    process.env.LUME_CONFIG_DIR = rel;

    const resolved = getConfigDir();
    expect(isAbsolute(resolved)).toBeTrue();
    expect(resolved.endsWith(rel)).toBeTrue();
    created.push(resolved);
  });

  test("应返回 lume.yaml 与 lume.audit.jsonl 路径", () => {
    const root = getConfigDir().replace(/\\/g, "/");
    expect(getLumeConfigYamlPath().replace(/\\/g, "/")).toBe(`${root}/lume.yaml`);
    expect(getLumeConfigAuditPath().replace(/\\/g, "/")).toBe(`${root}/lume.audit.jsonl`);
    expect(getGlobalMemoryPath().replace(/\\/g, "/")).toBe(`${root}/MEMORY.md`);
    expect(getGlobalMemoryDbPath().replace(/\\/g, "/")).toBe(`${root}/.meta/memory.sqlite`);
  });

  test("workspace 与 thread 目录应符合新结构", () => {
    const dir = mkdtempSync(join(tmpdir(), "lume-config-paths-layout-"));
    created.push(dir);
    process.env.LUME_CONFIG_DIR = dir;

    const resources = getWorkspaceResourcesPath("demo");
    const meta = getWorkspaceMetaPath("demo");
    const longTermMemory = getWorkspaceLongTermMemoryPath("demo");
    const threadRoot = getAgentThreadRootPath("demo", "thread-1");
    const threadFiles = getAgentThreadFilesPath("demo", "thread-1");
    const threadArtifacts = getAgentThreadArtifactsPath("demo", "thread-1");
    const threadContext = getAgentThreadSystemContextPath("demo", "thread-1");

    expect(resources.endsWith(join("agent-workspaces", "demo", "resources"))).toBeTrue();
    expect(meta.endsWith(join("agent-workspaces", "demo", ".meta"))).toBeTrue();
    expect(longTermMemory.endsWith(join("agent-workspaces", "demo", "MEMORY.md"))).toBeTrue();
    expect(threadRoot.endsWith(join("agent-workspaces", "demo", "threads", "thread-1"))).toBeTrue();
    expect(threadFiles.endsWith(join("agent-workspaces", "demo", "threads", "thread-1", "files"))).toBeTrue();
    expect(threadArtifacts.endsWith(join("agent-workspaces", "demo", "threads", "thread-1", "artifacts"))).toBeTrue();
    expect(threadContext.endsWith(join("agent-workspaces", "demo", "threads", "thread-1", ".context"))).toBeTrue();
  });
});
