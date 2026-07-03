import { describe, expect, test } from "bun:test";
import {
  inferCapabilityLanes,
  resolvePreferredCapabilityRoute,
  resolveSoftToolPolicyForPreferredRoute
} from "./capability-routing";

describe("capability-routing", () => {
  test("inferCapabilityLanes 应按工具集合推导 lanes", () => {
    expect(
      inferCapabilityLanes(["Skill", "browser", "memory.search", "web_search", "read", "write"])
    ).toEqual(["skills", "browser", "memory", "web", "raw-tools"]);
    expect(inferCapabilityLanes(["memory.search", "memory.read"])).toEqual(["memory"]);
  });

  test("用户明确要求低层控制时应优先 raw-tools", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "直接给我 bash 命令，我要手动执行",
      availableTools: ["Skill", "read", "write", "bash"]
    });
    expect(decision.preferredLane).toBe("raw-tools");
    expect(decision.reason).toContain("low-level");
  });

  test("匹配已加载 skill 元数据时应优先 skills", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "帮我做一个 execution plan",
      availableTools: ["Skill", "read", "write"],
      loadedSkills: [
        {
          slug: "planner",
          name: "Execution Planner",
          description: "Breaks work into clear execution plans"
        }
      ]
    });
    expect(decision.preferredLane).toBe("skills");
    expect(decision.reason).toContain("loaded skill metadata");
  });

  test("显式 $plugin 调用应优先 skills，即使请求里包含搜索意图", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "$lume-chrome 打开百度并搜索 glm",
      availableTools: ["Skill", "browser", "WebSearch", "WebFetch", "read"],
      loadedSkills: [
        {
          slug: "lume-chrome:control-browser",
          name: "lume-chrome",
          description: "Control Chrome browser through node_repl"
        }
      ]
    });

    expect(decision.preferredLane).toBe("skills");
    expect(decision.reason).toContain("explicit skill");
  });

  test("whenToUse 可参与 skill 路由匹配，manual-only skill 不参与", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "我需要做一次 code review",
      availableTools: ["Skill", "Read"],
      loadedSkills: [
        {
          slug: "code-review",
          name: "代码审查",
          description: "质量检查",
          whenToUse: "当用户要求 code review 时使用"
        },
        {
          slug: "manual-only",
          name: "手动技能",
          description: "code review",
          disableModelInvocation: true
        }
      ]
    });

    expect(decision.preferredLane).toBe("skills");
    expect(decision.reason).toContain("loaded skill metadata");
  });

  test("仅匹配 manual-only skill 时不应优先 skills", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "请 code review",
      availableTools: ["Skill", "Read"],
      loadedSkills: [
        {
          slug: "manual-only",
          name: "手动技能",
          description: "code review",
          disableModelInvocation: true
        }
      ]
    });

    expect(decision.preferredLane).toBe("raw-tools");
  });

  test("浏览器请求应优先 browser", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "继续在当前页面操作浏览器",
      availableTools: ["browser", "web_search", "read"]
    });
    expect(decision.preferredLane).toBe("browser");
  });

  test("历史连续性请求应优先 memory", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "回忆一下我们之前确认过的偏好",
      availableTools: ["memory.search", "memory.read", "read"]
    });
    expect(decision.preferredLane).toBe("memory");
  });

  test("当前协作状态请求应优先 memory 让主 agent 自行判断是否召回", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "你能知道我们现在干嘛吗？",
      availableTools: ["memory.search", "memory.read", "read"]
    });
    expect(decision.preferredLane).toBe("memory");
    expect(decision.reason).toContain("continuity");
  });

  test("接着上次继续这类隐式连续性请求应优先 memory", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "我们接着上次继续优化",
      availableTools: ["memory.search", "memory.read", "read"]
    });
    expect(decision.preferredLane).toBe("memory");
    expect(decision.reason).toContain("continuity");
  });

  test("公共检索请求应优先 web", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "搜索一下这个产品的最新消息",
      availableTools: ["web_search", "read"]
    });
    expect(decision.preferredLane).toBe("web");
  });

  test("没有明确 skill 匹配时默认使用 raw-tools 而不是 skills-first", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "帮我看一下这个文件",
      availableTools: ["Skill", "read", "write"],
      loadedSkills: [
        {
          slug: "xlsx",
          name: "Spreadsheet",
          description: "Use for spreadsheet files"
        }
      ]
    });

    expect(decision.preferredLane).toBe("raw-tools");
    expect(decision.reason).toContain("use direct tools");
  });

  test("没有 user message 时也不应 fallback 到 skills-first", () => {
    const decision = resolvePreferredCapabilityRoute({
      availableTools: ["Skill", "read", "write"],
      loadedSkills: [
        {
          slug: "xlsx",
          name: "Spreadsheet",
          description: "Use for spreadsheet files"
        }
      ]
    });

    expect(decision.preferredLane).toBe("raw-tools");
    expect(decision.reason).toContain("default to direct tools");
  });

  test("browser/memory/web 路由应生成保守 soft tool policy", () => {
    expect(resolveSoftToolPolicyForPreferredRoute("browser")).toEqual({
      deny: ["web_search", "web_fetch"]
    });
    expect(resolveSoftToolPolicyForPreferredRoute("memory")).toEqual({
      deny: ["web_search", "web_fetch"]
    });
    expect(resolveSoftToolPolicyForPreferredRoute("web")).toEqual({
      deny: ["browser"]
    });
    expect(resolveSoftToolPolicyForPreferredRoute("skills")).toBeUndefined();
  });
});
