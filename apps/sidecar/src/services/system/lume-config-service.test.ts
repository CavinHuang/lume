import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
  type LumeConfigFile,
  type LumeConfigSectionSet
} from "@lume/shared";
import YAML from "yaml";
import { getLumeConfigAuditPath, getLumeConfigYamlPath } from "../infra/config-paths";
import { getEffectiveLumeConfig, getEffectivePluginRuntimeConfig, KNOWN_LUME_SECTION_KEYS, updateLumeConfigSection } from "./lume-config-service";

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

    expect(effective.version).toBe(2);
    expect(effective.workspaceSlug).toBe("default");
    expect(effective.sourcePath).toBe(getLumeConfigYamlPath());
    expect(existsSync(getLumeConfigYamlPath())).toBeTrue();

    const file = YAML.parse(readFileSync(getLumeConfigYamlPath(), "utf-8")) as LumeConfigFile;
    expect(file.version).toBe(2);
    expect(file.skills?.enabled).toEqual([]);
    expect(file.plugins?.global?.enabled).toEqual([]);
    expect(file.plugins?.global?.disabled).toEqual([]);
    expect(file.plugins?.workspaces).toEqual({});
    expect(file.plugins?.directories).toEqual([]);
    expect(file.plugins?.marketSources).toEqual([{
      id: "official",
      name: "Lume Plugins",
      kind: "remote-index",
      enabled: true,
      url: "https://github.com/CavinHuang/lume-plugins",
      mirrorUrl: "https://lume-plugin.mrhuang.site"
    }]);
    expect(file.permissions?.rules).toEqual([]);
    // #571 第 1 项：分类器新默认开启（少打扰档从出厂即可达）
    expect(file.permissions?.classifier?.enabled).toBe(true);
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

  test("同 tick 原子重写（等长内容+新 inode+mtime 钉回）必须使缓存失效重读", () => {
    // 跨进程写盘走 tmp+rename（每次新 inode）。粗粒度时间戳文件系统（Linux
    // jiffy 粒度，#622 同类）上仅 mtime+size 判等时，同 tick 的两连写会被误判
    // 未变——被遮蔽的若是最后一次写，stale 配置伴随进程存活期。指纹补 ino 后
    // 必然失效重读。
    const path = getLumeConfigYamlPath();
    const pinnedTime = new Date(Date.now() - 10_000);
    getEffectiveLumeConfig("default"); // 首建：写盘的是未规范化的默认模板
    utimesSync(path, pinnedTime, pinnedTime);
    getEffectiveLumeConfig("default"); // 强制 miss → 惰性规范化重写在此发生并刷新采样
    utimesSync(path, pinnedTime, pinnedTime);
    getEffectiveLumeConfig("default"); // 再 miss 一次：此时内容已是不动点，仅以钉住的 mtime 重采样
    // 至此缓存指纹 = {pinned, size, ino@磁盘}，后续唯一可控差异只剩 ino

    const raw = readFileSync(path, "utf-8");
    // 等长替换保证 size 无从区分；选 embedding.defaultModelRef（规范化仅 trim、
    // 不做官方源回写），观测面走 getEffectiveLumeConfig
    expect(raw.includes("bge-small-zh-v1.5")).toBeTrue();
    const modified = raw.replace(
      "local-onnx/Xenova/bge-small-zh-v1.5",
      "local-onnx/Xenova/bge-small-zh-v1.6"
    );
    const tempPath = `${path}.test-tmp`;
    writeFileSync(tempPath, modified, "utf-8");
    renameSync(tempPath, path);
    utimesSync(path, pinnedTime, pinnedTime);

    expect(getEffectiveLumeConfig("default").models?.embedding?.defaultModelRef)
      .toBe("local-onnx/Xenova/bge-small-zh-v1.6");
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

  test("应规范化 Computer Use 的 agent surface 和 sky 模型列表", () => {
    updateLumeConfigSection({
      source: "system",
      path: "models.computerUse",
      value: {
        agentSurface: "sky",
        skyModelRefs: ["openai/gpt-5", " openai/gpt-5 ", ""],
        visionModelRefs: ["google/gemini-2.5-flash"],
      },
    });

    expect(getEffectiveLumeConfig("default").models?.computerUse).toEqual({
      agentSurface: "sky",
      skyModelRefs: ["openai/gpt-5"],
      visionModelRefs: ["google/gemini-2.5-flash"],
    });
  });

  test("#573① review M1: agent.maxAutoTurnContinuations 经 normalize 存活且越界值被钳制", () => {
    updateLumeConfigSection({
      source: "user",
      path: "agent",
      value: { maxAutoTurnContinuations: 5, permissionMode: "dontAsk", followUpQueueMode: "steer" },
    });    const effective = getEffectiveLumeConfig("default").agent;
    expect(effective?.maxAutoTurnContinuations).toBe(5);
    expect(effective?.permissionMode).toBe("dontAsk");
    // followUpQueueMode 同族：白名单缺失曾使配置恒回落 'queue'（web AgentInput 读取点）
    expect(effective?.followUpQueueMode).toBe("steer");
    updateLumeConfigSection({ source: "user", path: "agent", value: { followUpQueueMode: "interrupt" } });
    expect(getEffectiveLumeConfig("default").agent?.followUpQueueMode).toBe("interrupt");

    // 越界钳到硬上限 10；非有限数值回落默认（字段被剥）
    updateLumeConfigSection({ source: "user", path: "agent", value: { maxAutoTurnContinuations: 99 } });
    expect(getEffectiveLumeConfig("default").agent?.maxAutoTurnContinuations).toBe(10);
    updateLumeConfigSection({ source: "user", path: "agent", value: { maxAutoTurnContinuations: Number.NaN } });
    expect(getEffectiveLumeConfig("default").agent?.maxAutoTurnContinuations).toBeUndefined();
    // 非法枚举值被剥
    updateLumeConfigSection({ source: "user", path: "agent", value: { followUpQueueMode: "bogus" } });
    expect(getEffectiveLumeConfig("default").agent?.followUpQueueMode).toBeUndefined();
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
        marketSources: [{ id: "official", name: "Official", kind: "remote-index", url: "https://example.com/index.json", mirrorUrl: "https://mirror.example", enabled: true }]
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
    expect(file.plugins?.marketSources?.[0]).toEqual({
      id: "official",
      name: "Lume Plugins",
      kind: "remote-index",
      enabled: true,
      url: "https://github.com/CavinHuang/lume-plugins",
      mirrorUrl: "https://mirror.example"
    });
  });

  test("应允许显式禁用官方插件市场", () => {
    updateLumeConfigSection({
      source: "system",
      path: "plugins.marketSources",
      value: [{
        id: "official",
        name: "Wrong name",
        kind: "remote-index",
        url: "https://example.com/wrong",
        enabled: false
      }]
    });

    const file = YAML.parse(readFileSync(getLumeConfigYamlPath(), "utf-8")) as LumeConfigFile;
    expect(file.plugins?.marketSources?.[0]).toEqual({
      id: "official",
      name: "Lume Plugins",
      kind: "remote-index",
      enabled: false,
      url: "https://github.com/CavinHuang/lume-plugins",
      mirrorUrl: "https://lume-plugin.mrhuang.site"
    });
    expect(getEffectivePluginRuntimeConfig("default").marketSources).toEqual([]);
  });

  test("应保存 Advisor 的独立模型并支持显式禁用", () => {
    updateLumeConfigSection({
      source: "system",
      path: "models.advisor",
      value: { defaultModelRef: " openai/gpt-5-mini ", enabled: true }
    });

    expect(getEffectiveLumeConfig("default").models?.advisor).toEqual({
      defaultModelRef: "openai/gpt-5-mini",
      enabled: true
    });

    updateLumeConfigSection({
      source: "agent",
      workspaceSlug: "default",
      path: "models.advisor",
      value: { enabled: false }
    });
    expect(getEffectiveLumeConfig("default").models?.advisor).toEqual({
      defaultModelRef: "openai/gpt-5-mini",
      enabled: false
    });
  });

  test("应允许环境变量覆盖默认官方镜像地址", () => {
    const previous = process.env.LUME_PLUGIN_MARKET_MIRROR_URL;
    process.env.LUME_PLUGIN_MARKET_MIRROR_URL = "https://mirror.override.example";
    try {
      expect(getEffectivePluginRuntimeConfig("default").marketSources[0]?.mirrorUrl)
        .toBe("https://mirror.override.example");
    } finally {
      if (previous === undefined) delete process.env.LUME_PLUGIN_MARKET_MIRROR_URL;
      else process.env.LUME_PLUGIN_MARKET_MIRROR_URL = previous;
    }
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
    expect(runtime.marketSources.map((source) => source.id)).toEqual(["official", "team"]);
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

    expect(effective.version).toBe(2);
    expect(effective.agent).toEqual({});
    expect(effective.providers).toEqual({});
    expect(effective.mcp).toEqual({});
    expect(effective.skills?.enabled).toEqual([]);
    expect(effective.permissions?.toolPolicy?.allow).toEqual([]);
  });

  test("v1 存量配置的 classifier.enabled=false 一次性迁移为新默认 true 并落盘 version:2", () => {
    // v1 规范化器把 enabled:false 写穿到每份落盘配置且 UI 从未露出该开关，
    // 存量 false 是默认值残留而非用户选择（#571 第 1 项）
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      permissions: {
        classifier: { enabled: false },
        rules: []
      }
    }), "utf-8");

    const effective = getEffectiveLumeConfig("default");
    expect(effective.permissions?.classifier?.enabled).toBe(true);

    const file = YAML.parse(readFileSync(getLumeConfigYamlPath(), "utf-8")) as LumeConfigFile;
    expect(file.version).toBe(2);
    expect(file.permissions?.classifier?.enabled).toBe(true);

    // 迁移后用户显式改回 false 不再被触碰
    file.permissions!.classifier!.enabled = false;
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify(file), "utf-8");
    const reaffirmed = getEffectiveLumeConfig("default");
    expect(reaffirmed.permissions?.classifier?.enabled).toBe(false);
  });

  test("无 classifier 段的 v1 存量配置经兜底语义获得启用，workspace overlay 显式 false 不迁移", () => {
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      workspaces: {
        default: {
          permissions: {
            classifier: { enabled: false }
          }
        }
      }
    }), "utf-8");

    // 顶层无显式值 → 规范化合并落新默认 true（v2 createDefault），等效于启用
    const topLevel = getEffectiveLumeConfig();
    expect(topLevel.permissions?.classifier?.enabled).toBe(true);

    // workspace overlay 是显式配置，不参与迁移，合并后覆盖生效
    const overlay = getEffectiveLumeConfig("default");
    expect(overlay.permissions?.classifier?.enabled).toBe(false);
  });

  // ─── #706：writeYamlAtomic 并发交错收口 ───

  test("#706：连续两次写入不碰撞、不留孤儿 tmp、终值正确", () => {
    updateLumeConfigSection({ source: "agent", path: "models.title.defaultModelRef", value: "openai/a" });
    updateLumeConfigSection({ source: "agent", path: "models.title.defaultModelRef", value: "openai/b" });

    const leftovers = readdirSync(dirname(getLumeConfigYamlPath()))
      .filter((name) => name.startsWith("lume.yaml.tmp."));
    expect(leftovers).toEqual([]);
    expect(getEffectiveLumeConfig().models?.title?.defaultModelRef).toBe("openai/b");
  });

  test("#706：崩溃遗留的过期 tmp 被清扫、新鲜 tmp 不误删", () => {
    const dir = dirname(getLumeConfigYamlPath());
    const stalePath = join(dir, `lume.yaml.tmp.999.${"a".repeat(8)}`);
    writeFileSync(stalePath, "junk", "utf-8");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stalePath, twoHoursAgo, twoHoursAgo);
    const freshPath = join(dir, `lume.yaml.tmp.${process.pid}.fresh000`);
    writeFileSync(freshPath, "junk", "utf-8");

    try {
      updateLumeConfigSection({ source: "agent", path: "models.title.defaultModelRef", value: "openai/c" });
      expect(existsSync(stalePath)).toBeFalse();
      expect(existsSync(freshPath)).toBeTrue();
    } finally {
      rmSync(freshPath, { force: true });
    }
  });

  test("#706：v2 迁移审计移到写盘成功后——恰好一条且重复读取不再追加", () => {
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      permissions: {
        classifier: { enabled: false },
        rules: []
      }
    }), "utf-8");

    getEffectiveLumeConfig();
    getEffectiveLumeConfig();

    const migrationEntries = readFileSync(getLumeConfigAuditPath(), "utf-8")
      .split("\n")
      .filter((line) => line.includes("permissions.classifier.enabled"));
    expect(migrationEntries).toHaveLength(1);
  });

  // #727 review 并发方向 P2：classifier 段缺失/非对象时 normalize 走兜底合并
  // 而非「false→true」翻转，审计不得虚记。
  test("#706：v1 无 classifier 段的文件不产生假迁移审计", () => {
    writeFileSync(getLumeConfigYamlPath(), YAML.stringify({
      version: 1,
      permissions: { rules: [] }
    }), "utf-8");

    getEffectiveLumeConfig();

    const migrationEntries = existsSync(getLumeConfigAuditPath())
      ? readFileSync(getLumeConfigAuditPath(), "utf-8").split("\n").filter((line) => line.includes("permissions.classifier.enabled"))
      : [];
    expect(migrationEntries).toHaveLength(0);
  });

  // #727 review 测试完备 P2：写失败必须如实上抛（update 响亮路径）且不记未发生
  // 的迁移/用户审计，tmp 不残留；读路径失败则优雅回退不崩。
  // 注入点（bak 已删）：yaml 本位被目录占用——rename(file→dir) 跨平台必炸。
  test("#706：配置位被目录占用时 update 上抛、零审计、tmp 清理，读取优雅回退", () => {
    const yamlPath = getLumeConfigYamlPath();
    rmSync(yamlPath, { force: true });
    mkdirSync(yamlPath);

    // 读路径：读取失败回退默认配置，不向 48 处热调用方抛错
    expect(() => getEffectiveLumeConfig()).not.toThrow();

    // 写路径：update 必须响亮失败（rename 落在目录位上）
    let threw = false;
    try {
      updateLumeConfigSection({ source: "agent", path: "models.title.defaultModelRef", value: "openai/x" });
    } catch {
      threw = true;
    }
    expect(threw).toBeTrue();

    const dir = dirname(yamlPath);
    const leftovers = readdirSync(dir).filter((name) => name.startsWith("lume.yaml.tmp."));
    expect(leftovers).toEqual([]);
    if (existsSync(getLumeConfigAuditPath())) {
      const auditLines = readFileSync(getLumeConfigAuditPath(), "utf-8").split("\n").filter((line) => line.trim());
      expect(auditLines).toHaveLength(0);
    }
  });

});

describe("#649 round3: 剥键白名单与 normalize 实际处理集一致", () => {
  test("KNOWN_LUME_SECTION_KEYS 覆盖 LumeConfigSectionSet 全部 section + 顶层 version/workspaces", () => {
    // 与 shared LumeConfigSectionSet 十字段逐一对照——shared 新增 section 而未更新
    // KNOWN 清单时,此处显式失败提醒同步(否则合法键被误报「未识别」刷屏)
    const allSections: Required<Pick<LumeConfigSectionSet, keyof LumeConfigSectionSet>> = {
      models: {}, agent: {}, providers: {}, mcp: {}, memory: {},
      skills: {}, plugins: {}, permissions: {}, hooks: {}, webSearch: {}
    };
    for (const key of Object.keys(allSections)) {
      expect(KNOWN_LUME_SECTION_KEYS).toContain(key);
    }
    // 顶层文件段由 normalizeLumeConfigFile 消费,同样必须豁免
    expect(KNOWN_LUME_SECTION_KEYS).toContain("version");
    expect(KNOWN_LUME_SECTION_KEYS).toContain("workspaces");
    // 幽灵键守卫:清单里的每个键都必须真实存在于类型面
    for (const key of KNOWN_LUME_SECTION_KEYS) {
      const known = key === "version" || key === "workspaces"
        || Object.prototype.hasOwnProperty.call(allSections, key);
      expect(known).toBe(true);
    }
  });
});
