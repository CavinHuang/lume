import type { AgentThreadMessage } from '@lume/shared'

/** 角色 → Markdown 标题标签 */
const ROLE_LABEL: Record<AgentThreadMessage['role'], string> = {
  user: '👤 用户',
  assistant: '🤖 助手',
  tool: '🔧 工具',
  status: '📋 状态',
}

/**
 * 把会话消息列表拼接为 Markdown 文本，用于「复制为 Markdown」。
 * 跳过空内容消息；工具调用/结果仅以角色标签 + content 简述呈现（YAGNI，不做完整还原）。
 */
export function threadToMarkdown(title: string, messages: AgentThreadMessage[]): string {
  const header = `# ${title?.trim() || '未命名会话'}`
  if (messages.length === 0) return header

  const body = messages
    .map((m) => {
      const content = m.content?.trim() ?? ''
      if (!content) return null
      const label = ROLE_LABEL[m.role] ?? m.role
      return `## ${label}\n\n${content}`
    })
    .filter((line): line is string => line !== null)

  return [header, ...body].join('\n\n')
}
