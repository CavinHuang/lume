import type { SubagentTask } from '@lume/shared'

type DispatchMode = 'continue_task' | 'new_task' | 'new_task_existing_session'
type RejectionReason = 'target_required' | 'explicit_instruction_required' | 'new_task_required' | 'conflicting_target' | 'task_not_found'

export type SubagentDispatchDecision =
  | { allowed: true; mode: DispatchMode }
  | { allowed: false; reason: RejectionReason; message: string }

export function resolveSubagentDispatchPolicy(input: {
  prompt: string
  taskId?: string
  subagentId?: string
  newTask?: boolean
  unresolvedTasks: SubagentTask[]
}): SubagentDispatchDecision {
  const prompt = input.prompt.trim()
  const taskId = input.taskId?.trim()
  const subagentId = input.subagentId?.trim()

  if (taskId && input.newTask) {
    return reject('conflicting_target', '不能同时设置 task_id 与 new_task；继续旧任务或创建新任务只能二选一。')
  }
  if (taskId && !input.unresolvedTasks.some((task) => task.taskId === taskId)) {
    return reject('task_not_found', `当前父会话中没有可继续的 task_id=${taskId}。`)
  }
  if (!taskId && !input.newTask) {
    const targets = input.unresolvedTasks.map((task) => task.taskId).join(', ')
    return reject(
      input.unresolvedTasks.length ? 'target_required' : 'new_task_required',
      input.unresolvedTasks.length
        ? `存在未结子任务 ${targets}。请指定 task_id 并派发具体反馈；如确需独立任务，设置 new_task=true。`
        : '创建独立子任务必须设置 new_task=true；用户消息不能直接作为子任务提示词。',
    )
  }
  if (!prompt || isContinuationOnly(prompt)) {
    return reject('explicit_instruction_required', '子任务提示词必须是主 Agent 派发的具体指令，不能只写“继续”。')
  }
  if (taskId) return { allowed: true, mode: 'continue_task' }
  return { allowed: true, mode: subagentId ? 'new_task_existing_session' : 'new_task' }
}

export function buildSubagentWorkContext(tasks: SubagentTask[]): string {
  if (!tasks.length) return ''
  const rows = tasks.map((task) =>
    `- task_id=${task.taskId}; subagent_id=${task.subagentId}; status=${task.status}; objective=${task.objective}`,
  )
  return [
    '<subagent_work>',
    '以下是当前父会话尚未结束的子任务。用户输入只属于主会话；如需子代理续作，主 Agent 必须选择 task_id 并编写具体派发指令。',
    ...rows,
    '</subagent_work>',
  ].join('\n')
}

function isContinuationOnly(value: string): boolean {
  return /^(继续|接着(?:做|来|处理)?|继续处理|continue|go\s+on)[。.!！?？\s]*$/iu.test(value)
}

function reject(reason: RejectionReason, message: string): SubagentDispatchDecision {
  return { allowed: false, reason, message }
}
