import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
  type LumeConfigFile
} from "@lume/shared";
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
    expect(file.plugins?.enabled).toEqual([]);
    expect(file.plugins?.directories).toEqual([]);
    expect(file.permissions?.rules).toEqual([]);
    expect(file.permissions?.classifier?.enabled).toBe(false);
    expect(file.permissions?.privateWriteRoots).toEqual([]);
    expect(file.models?.embedding?.defaultModelRef).toBe(MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF);
    expect(file.workspaces).toEqual({});
  });

  test("应默认启用内部 workflow hooks", () => {
    const effective = getEffectiveLumeConfig("default");

    expect(effective.hooks?.internal).toEqual({
      enabled: true,
      memory: true,
      security: true,
      observability: true
    });
  });

  test("应识别 guanlan 搜索后端并同步启用顺序到环境变量", () => {
    const prevProviders = process.env.LUME_WEB_SEARCH_PROVIDERS;
    const prevGuanlanEnabled = process.env.LUME_GUANLAN_ENABLED;
    const prevGuanlanPython = process.env.LUME_GUANLAN_PYTHON;
    const prevLumePython = process.env.LUME_PYTHON;
    try {
      process.env.LUME_PYTHON = "/custom/python";
      updateLumeConfigSection({
        source: "system",
        path: "webSearch",
        value: {
          strategy: "priority",
          providers: {
            guanlan: { enabled: true },
            exa: { enabled: false, apiKey: "exa-key" },
            bing: { enabled: true },
            duckduckgo: { enabled: false }
          }
        }
      });

      const effective = getEffectiveLumeConfig("default");

      expect(effective.webSearch?.providers?.guanlan).toEqual({ enabled: true });
      expect(process.env.LUME_WEB_SEARCH_PROVIDERS).toBe("guanlan,bing");
      expect(process.env.LUME_GUANLAN_ENABLED).toBe("1");
      expect(process.env.LUME_GUANLAN_PYTHON).toBe("/custom/python");
    } finally {
      if (prevProviders === undefined) delete process.env.LUME_WEB_SEARCH_PROVIDERS;
      else process.env.LUME_WEB_SEARCH_PROVIDERS = prevProviders;
      if (prevGuanlanEnabled === undefined) delete process.env.LUME_GUANLAN_ENABLED;
      else process.env.LUME_GUANLAN_ENABLED = prevGuanlanEnabled;
      if (prevGuanlanPython === undefined) delete process.env.LUME_GUANLAN_PYTHON;
      else process.env.LUME_GUANLAN_PYTHON = prevGuanlanPython;
      if (prevLumePython === undefined) delete process.env.LUME_PYTHON;
      else process.env.LUME_PYTHON = prevLumePython;
    }
  });

  test("禁用 guanlan 时不设置 guanlan 启用标记", () => {
    const prevProviders = process.env.LUME_WEB_SEARCH_PROVIDERS;
    const prevGuanlanEnabled = process.env.LUME_GUANLAN_ENABLED;
    const prevGuanlanPython = process.env.LUME_GUANLAN_PYTHON;
    try {
      updateLumeConfigSection({
        source: "system",
        path: "webSearch",
        value: {
          providers: {
            guanlan: { enabled: false },
            bing: { enabled: true }
          }
        }
      });

      getEffectiveLumeConfig("default");

      expect(process.env.LUME_WEB_SEARCH_PROVIDERS).toBe("bing");
      expect(process.env.LUME_GUANLAN_ENABLED).toBe("");
      expect(process.env.LUME_GUANLAN_PYTHON).toBe("");
    } finally {
      if (prevProviders === undefined) delete process.env.LUME_WEB_SEARCH_PROVIDERS;
      else process.env.LUME_WEB_SEARCH_PROVIDERS = prevProviders;
      if (prevGuanlanEnabled === undefined) delete process.env.LUME_GUANLAN_ENABLED;
      else process.env.LUME_GUANLAN_ENABLED = prevGuanlanEnabled;
      if (prevGuanlanPython === undefined) delete process.env.LUME_GUANLAN_PYTHON;
      else process.env.LUME_GUANLAN_PYTHON = prevGuanlanPython;
    }
  });

  test("应支持 hooks.internal 的 workspace 覆盖", () => {
    updateLumeConfigSection({
      source: "system",
      path: "hooks.internal",
      value: {
        enabled: true,
        memory: true,
        security: true,
        observability: false
      }
    });

    updateLumeConfigSection({
      source: "agent",
      workspaceSlug: "default",
      path: "hooks.internal",
      value: {
        memory: false,
        security: false
      }
    });

    const defaultEffective = getEffectiveLumeConfig("default");
    const anotherEffective = getEffectiveLumeConfig("another");

    expect(defaultEffective.hooks?.internal).toEqual({
      enabled: true,
      memory: false,
      security: false,
      observability: false
    });
    expect(anotherEffective.hooks?.internal).toEqual({
      enabled: true,
      memory: true,
      security: true,
      observability: false
    });
  });

  test("应支持权限规则、分类器和私有写入根的 workspace 覆盖", () => {
    updateLumeConfigSection({
      source: "system",
      path: "permissions",
      value: {
        rules: [{ id: "global-bash", tool: "Bash", commandPattern: "^ls", action: "allow", scope: "global" }],
        classifier: { enabled: true },
        privateWriteRoots: [".lume"]
      }
    });

    updateLumeConfigSection({
      source: "agent",
      workspaceSlug: "default",
      path: "permissions",
      value: {
        rules: [{ id: "workspace-rm", tool: "Bash", commandPattern: "^rm", action: "ask", scope: "workspace" }],
        classifier: { enabled: false },
        privateWriteRoots: [".lume/artifacts"]
      }
    });

    const effective = getEffectiveLumeConfig("default");

    expect(effective.permissions?.rules?.map((rule) => rule.id)).toEqual(["global-bash", "workspace-rm"]);
    expect(effective.permissions?.classifier?.enabled).toBe(false);
    expect(effective.permissions?.privateWriteRoots).toEqual([".lume", ".lume/artifacts"]);
  });

  test("应支持权限审批路由配置并允许 workspace 覆盖", () => {
    updateLumeConfigSection({
      source: "system",
      path: "permissions.approvals",
      value: {
        subagent: {
          mode: "ask-parent",
          allowAlways: "desktop-only"
        },
        im: {
          enabled: true,
          allowTextApprove: true,
          allowAlways: "desktop-only",
          groupApproval: "desktop-only",
          accounts: {
            "weixin-work": {
              enabled: true,
              allowTextApprove: true,
              allowAlways: "dm-only"
            }
          }
        }
      }
    });

    updateLumeConfigSection({
      source: "agent",
      workspaceSlug: "default",
      path: "permissions.approvals",
      value: {
        im: {
          allowTextApprove: false,
          accounts: {
            "weixin-work": {
              enabled: false
            },
            "weixin-personal": {
              enabled: true
            }
          }
        }
      }
    });

    const effective = getEffectiveLumeConfig("default");

    expect(effective.permissions?.approvals?.subagent).toEqual({
      mode: "ask-parent",
      allowAlways: "desktop-only"
    });
    expect(effective.permissions?.approvals?.im).toEqual({
      enabled: true,
      allowTextApprove: false,
      allowAlways: "desktop-only",
      groupApproval: "desktop-only",
      accounts: {
        "weixin-work": {
          enabled: false,
          allowTextApprove: true,
          allowAlways: "dm-only"
        },
        "weixin-personal": {
          enabled: true
        }
      }
    });
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

  test("默认使用本地 ONNX embedding，但允许 workspace 覆盖", () => {
    updateLumeConfigSection({
      source: "agent",
      workspaceSlug: "default",
      path: "models.embedding.defaultModelRef",
      value: "siliconflow/BAAI/bge-m3"
    });

    const defaultEffective = getEffectiveLumeConfig("default");
    const anotherEffective = getEffectiveLumeConfig("another");

    expect(defaultEffective.models?.embedding?.defaultModelRef).toBe("siliconflow/BAAI/bge-m3");
    expect(anotherEffective.models?.embedding?.defaultModelRef).toBe(MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF);
  });

  test("应支持子 Agent 默认模型配置并允许 workspace 覆盖", () => {
    updateLumeConfigSection({
      source: "system",
      path: "models.subagent.defaultModelRef",
      value: "openai/gpt-5.4-mini"
    });

    updateLumeConfigSection({
      source: "agent",
      workspaceSlug: "default",
      path: "models.subagent.defaultModelRef",
      value: "anthropic/claude-sonnet-4-5"
    });

    const defaultEffective = getEffectiveLumeConfig("default");
    const anotherEffective = getEffectiveLumeConfig("another");

    expect(defaultEffective.models?.subagent?.defaultModelRef).toBe("anthropic/claude-sonnet-4-5");
    expect(anotherEffective.models?.subagent?.defaultModelRef).toBe("openai/gpt-5.4-mini");
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
