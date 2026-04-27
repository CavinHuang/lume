import { describe, expect, test } from "bun:test";
import {
  inferCapabilityLanes,
  resolvePreferredCapabilityRoute,
  resolveSoftToolPolicyForPreferredRoute
} from "./capability-routing";

describe("capability-routing", () => {
  test("inferCapabilityLanes 应按工具集合推导 lanes", () => {
    expect(
      inferCapabilityLanes(["Skill", "browser", "memory_search", "web_search", "read", "write"])
    ).toEqual(["skills", "browser", "memory", "web", "raw-tools"]);
  });

  test("用户明确要求低层控制时应优先 raw-tools", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "直接给我 bash 命令，我要手动执行",
      availableTools: ["Skill", "read", "write", "bash"]
    });
    expect(decision.preferredLane).toBe("raw-tools");
    expect(decision.reason).toContain("low-level");
  });

  test("没有明确 skill 匹配时，应默认回落 raw-tools 而不是 skills", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "分析一下这个提示词设计有什么问题",
      availableTools: ["Skill", "read", "write", "grep"],
      loadedSkills: [
        {
          slug: "brainstorming",
          name: "Brainstorming",
          description: "Use for ambiguous product and design exploration"
        }
      ]
    });
    expect(decision.preferredLane).toBe("raw-tools");
    expect(decision.reason).toContain("direct tools");
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
    expect(decision.reason).toContain("skill metadata");
  });

  test("浏览器请求应优先 browser", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "继续在当前页面操作浏览器",
      availableTools: ["browser", "web_search", "read"]
    });
    expect(decision.preferredLane).toBe("browser");
  });

  test("历史连续性请求应优先 memory，且不被 skills lane 抢占", () => {
    const decision = resolvePreferredCapabilityRoute({
      userMessage: "回忆一下我们之前确认过的偏好",
      availableTools: ["Skill", "memory_search", "memory_get", "read"],
      loadedSkills: [
        {
          slug: "brainstorming",
          name: "Brainstorming",
          description: "Use for ambiguous product and design exploration"
        }
      ]
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
