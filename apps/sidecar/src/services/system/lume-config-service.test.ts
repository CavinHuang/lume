import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LumeConfigFile } from "@lume/shared";
import YAML from "yaml";
import { getLumeConfigAuditPath, getLumeConfigYamlPath } from "../infra/config-paths";
import { getEffectiveLumeConfig, updateLumeConfigSection } from "./lume-config-service";

describe("lume-config-service", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-config-service-test-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("应在缺失时生成默认 lume.yaml 并返回有效配置", () => {
    const effective = getEffectiveLumeConfig("default");

    expect(effective.version).toBe(1);
    expect(effective.workspaceSlug).toBe("default");
    expect(effective.sourcePath).toBe(getLumeConfigYamlPath());
    expect(existsSync(getLumeConfigYamlPath())).toBeTrue();

    const file = YAML.parse(readFileSync(getLumeConfigYamlPath(), "utf-8")) as LumeConfigFile;
    expect(file.version).toBe(1);
    expect(file.skills?.enabled).toEqual([]);
    expect(file.workspaces).toEqual({});
  });

  test("应正确叠加 workspace 覆盖配置", () => {
    updateLumeConfigSection({
      source: "system",
      path: "models.agent.defaultModelRef",
      value: "openai/gpt-5.4"
    });

    updateLumeConfigSection({
      source: "agent",
      workspaceSlug: "default",
      path: "models.agent.defaultModelRef",
      value: "anthropic/claude-sonnet-4"
    });

    const defaultEffective = getEffectiveLumeConfig("default");
    const anotherEffective = getEffectiveLumeConfig("another");

    expect(defaultEffective.models?.agent?.defaultModelRef).toBe("anthropic/claude-sonnet-4");
    expect(anotherEffective.models?.agent?.defaultModelRef).toBe("openai/gpt-5.4");
  });

  test("写入配置后应追加审计日志", () => {
    updateLumeConfigSection({
      source: "agent",
      workspaceSlug: "default",
      path: "skills.enabled",
      value: ["brainstorming", "lume-file-governance"],
      summary: "启用工作区技能"
    });

    const lines = readFileSync(getLumeConfigAuditPath(), "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(lines.length).toBe(1);
    const firstLine = lines[0];
    expect(firstLine).toBeDefined();

    const parsed = JSON.parse(firstLine as string) as {
      source?: string;
      workspaceSlug?: string;
      path?: string;
      summary?: string;
    };
    expect(parsed.source).toBe("agent");
    expect(parsed.workspaceSlug).toBe("default");
    expect(parsed.path).toBe("skills.enabled");
    expect(parsed.summary).toBe("启用工作区技能");
  });

  test("lume.yaml 解析失败时应回退默认配置", () => {
    writeFileSync(getLumeConfigYamlPath(), "version: [", "utf-8");
    const effective = getEffectiveLumeConfig("default");

    expect(effective.version).toBe(1);
    expect(effective.agent).toEqual({});
    expect(effective.providers).toEqual({});
    expect(effective.mcp).toEqual({});
    expect(effective.skills?.enabled).toEqual([]);
    expect(effective.permissions?.toolPolicy?.allow).toEqual([]);
  });
});
