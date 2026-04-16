export function shouldSuggestAgentMode(userMessage: string): boolean {
  const normalized = userMessage.trim();
  if (!normalized) return false;
  if (/调研|研究|报告|分析|开发|代码|实现|重构|调试|测试|项目|文件|脚本|命令|自动化|多步骤|搭建|部署|数据库|api|workflow|pipeline|计划|执行|refactor|debug|test|build|research/iu.test(normalized)) {
    return true;
  }
  return normalized.length >= 80 && /\s|，|。|,|\./.test(normalized);
}

export function buildAgentModeRecommendation(userMessage: string): { reason: string; suggestedPrompt: string } {
  const normalized = userMessage.trim();
  return {
    reason: "该任务可能涉及多步骤执行、文件与命令操作，Agent 模式可持续执行并回写过程结果，适合复杂任务闭环。",
    suggestedPrompt: normalized.length > 0 ? normalized : "请基于当前需求继续执行"
  };
}
