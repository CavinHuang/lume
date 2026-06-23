import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
  type LumeConfigFile
} from "@lume/shared";
import YAML from "yaml";
import { getLumeConfigAuditPath, getLumeConfigYamlPath } from "../infra/config-paths";
import { getEffectiveLumeConfig, getEffectivePluginRuntimeConfig, updateLumeConfigSection } from "./lume-config-service";

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
    expect(file.plugins?.global?.enabled).toEqual([]);
    expect(file.plugins?.global?.disabled).toEqual([]);
    expect(file.plugins?.workspaces).toEqual({});
    expect(file.plugins?.directories).toEqual([]);
    expect(file.plugins?.marketSources).toEqual([]);
    expect(file.permissions?.rules).toEqual([]);
    expect(file.permissions?.classifier?.enabled).toBe(false);
    expect(file.permissions?.privateWriteRoots).toEqual([]);
    expect(file.models?.embedding?.defaultModelRef).toBe(MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF);
    expect(file.workspaces).toEqual({});
  });

  test("读取已规范化的 lume.yaml 时不应重写文件（避免触发文件监听回环）", () => {
    const path = getLumeConfigYamlPath();
    // 多次读取，确保落盘内容已到达规范化不动点
    getEffectiveLumeConfig("default");
    getEffectiveLumeConfig("default");
    const before = statSync(path).mtimeMs;

    getEffectiveLumeConfig("default");

    // 内容未变的重复读取不应再次写盘，否则会持续触发 workspace-watcher 的
    // lume-config:changed 事件，造成 get-effective ↔ 文件监听的无限回环
    expect(statSync(path).mtimeMs).toBe(before);
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

  test("应将旧 plugins.enabled/disabled 迁移为 canonical global 配置", () => {
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        enabled: ["legacy-a", "legacy-b", "legacy-a"],
        disabled: ["legacy-c"],
        directories: ["/plugins", "/plugins"],
        marketSources: [{ id: "official", name: "Official", kind: "remote-index", url: "https://example.com/index.json", enabled: true }]
      }
    }), "utf-8");

    const effective = getEffectiveLumeConfig("default");
    const file = YAML.parse(readFileSync(getLumeConfigYamlPath(), "utf-8")) as LumeConfigFile;

    expect(effective.plugins?.global?.enabled).toEqual(["legacy-a", "legacy-b"]);
    expect(effective.plugins?.global?.disabled).toEqual(["legacy-c"]);
    expect(file.plugins?.enabled).toBeUndefined();
    expect(file.plugins?.disabled).toBeUndefined();
    expect(file.plugins?.global?.enabled).toEqual(["legacy-a", "legacy-b"]);
    expect(file.plugins?.global?.disabled).toEqual(["legacy-c"]);
    expect(file.plugins?.directories).toEqual(["/plugins"]);
    expect(file.plugins?.marketSources?.[0]?.id).toBe("official");
  });

  test("应合并 global 与 workspace 插件启用配置", () => {
    updateLumeConfigSection({
      source: "system",
      path: "plugins",
      value: {
        global: {
          enabled: ["global-a", "shared"],
          disabled: ["global-off"]
        },
        directories: ["/global-plugins"],
        marketSources: [{ id: "team", name: "Team", kind: "local-index", path: "/market.json", enabled: true }],
        workspaces: {
          default: {
            enabled: ["workspace-a"],
            disabled: ["shared"]
          }
        }
      }
    });

    const runtime = getEffectivePluginRuntimeConfig("default");

    expect(runtime.enabled).toEqual(["global-a", "workspace-a"]);
    expect(runtime.disabled).toEqual(["global-off", "shared"]);
    expect(runtime.directories).toEqual(["/global-plugins"]);
    expect(runtime.marketSources.map((source) => source.id)).toEqual(["team"]);
  });

  test("应迁移旧 workspace overlay 的 plugins.enabled/disabled", () => {
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      plugins: {
        enabled: ["global-a"],
        directories: []
      },
      workspaces: {
        default: {
          plugins: {
            enabled: ["workspace-a"],
            disabled: ["global-a"]
          }
        }
      }
    }), "utf-8");

    const runtime = getEffectivePluginRuntimeConfig("default");
    const file = YAML.parse(readFileSync(getLumeConfigYamlPath(), "utf-8")) as LumeConfigFile;

    expect(runtime.enabled).toEqual(["workspace-a"]);
    expect(runtime.disabled).toEqual(["global-a"]);
    expect(file.workspaces?.default?.plugins?.enabled).toBeUndefined();
    expect(file.workspaces?.default?.plugins?.disabled).toBeUndefined();
    expect(file.plugins?.workspaces?.default?.enabled).toEqual(["workspace-a"]);
    expect(file.plugins?.workspaces?.default?.disabled).toEqual(["global-a"]);
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

  test("应支持日程调度模型配置并允许 workspace 覆盖", () => {
    updateLumeConfigSection({
      source: "system",
      path: "models.routine.defaultModelRef",
      value: "openai/routine-global"
    });

    updateLumeConfigSection({
      source: "agent",
      workspaceSlug: "default",
      path: "models.routine.defaultModelRef",
      value: "anthropic/routine-workspace"
    });

    const defaultEffective = getEffectiveLumeConfig("default");
    const anotherEffective = getEffectiveLumeConfig("another");

    expect(defaultEffective.models?.routine?.defaultModelRef).toBe("anthropic/routine-workspace");
    expect(anotherEffective.models?.routine?.defaultModelRef).toBe("openai/routine-global");
  });

  test("应支持后台模型、图像模型和上下文长度配置", () => {
    updateLumeConfigSection({
      source: "agent",
      path: "models.title",
      value: { defaultModelRef: "openai/title-model" }
    });
    updateLumeConfigSection({
      source: "agent",
      path: "models.imageGeneration",
      value: {
        priorityModelRefs: ["doubao/seedream", "openai/gpt-image"]
      }
    });
    updateLumeConfigSection({
      source: "agent",
      path: "models.contextWindows",
      value: {
        "openai/title-model": 128000
      }
    });

    const effective = getEffectiveLumeConfig();
    expect(effective.models?.title?.defaultModelRef).toBe("openai/title-model");
    expect(effective.models?.imageGeneration?.priorityModelRefs).toEqual(["doubao/seedream", "openai/gpt-image"]);
    expect(effective.models?.contextWindows?.["openai/title-model"]).toBe(128000);
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
