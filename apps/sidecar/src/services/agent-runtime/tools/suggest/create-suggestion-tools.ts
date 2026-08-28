import type { ToolDefinition } from "@lume/agent-sdk";
import { runAnalysisAndPersist } from "../../../suggest/service";
import { createSdkJsonResultTool } from "../sdk-tool-result";

/**
 * 主动建议工具：把 suggest 服务的 LLM 工作模式分析能力暴露为 Agent / automation
 * 可调用的 builtin 工具。
 *
 * - suggestion_analyze：无参数 → 调 runAnalysisAndPersist({})（全局范围）→ 返回
 *   { ok, added, summary }。低频高价值（不建议每天多次）。写副作用（落库候选），
 *   故 isReadOnly=false。
 *
 * 周期 3 Task 2。
 */
export function createSuggestionTools(
  analyze: typeof runAnalysisAndPersist = runAnalysisAndPersist,
): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "suggestion_analyze",
      description:
        "分析近期记忆与用户画像，发现可自动化/沉淀的工作模式，产出主动建议。低频高价值（不建议每天多次）。",
      inputSchema: {
        type: "object",
        properties: {},
      },
      async call() {
        const added = await analyze({});
        return {
          ok: true,
          added,
          summary: `分析了近期记忆，发现 ${added} 个候选模式，已加入主动中心`,
        };
      },
    }),
  ];
}
