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
