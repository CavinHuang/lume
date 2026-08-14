/**
 * Detects whether to enable coding-only bookkeeping such as file checkpoints.
 * This must never be used to register, hide, allow, or deny agent capabilities.
 */
export function shouldTrackCodingWorkflow(value?: string): boolean {
  const message = (value ?? "").trim().toLowerCase();
  if (!message) return false;
  if (containsAny(message, [
    "code", "coding", "implement", "implementation", "refactor", "bug", "fix", "test", "build", "typecheck",
    "代码", "编程", "实现", "修复", "重构", "测试", "编译", "类型错误", "报错"
  ])) return true;
  const hasUiArtifact = containsAny(message, [
    "ui", "css", "layout", "component", "界面", "组件", "样式", "弹窗", "层级", "遮挡", "遮住"
  ]);
  const hasChangeOrDiagnosis = containsAny(message, [
    "change", "update", "adjust", "optimize", "issue", "problem",
    "修改", "调整", "优化", "改造", "问题", "异常"
  ]);
  return hasUiArtifact && hasChangeOrDiagnosis;
}

function containsAny(text: string, patterns: string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}
