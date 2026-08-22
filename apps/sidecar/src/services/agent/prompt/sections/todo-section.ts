export function buildTodoSection(): string {
  return `## TodoWrite — 会话任务清单
用于包含 3 个以上不同步骤的多步工作，或用户一次提供的多个任务；单一琐事或纯对话请求不要使用。
同一时刻只保留一个 in_progress 任务；任务完成的当下立即标记 completed。`;
}
