export interface BuildWelcomeSurfaceViewModelInput {
  workspaceName: string | null
}

export interface WelcomeSurfaceHero {
  title: string
  subtitle: string
}

export interface WelcomeSurfaceViewModel {
  hero: WelcomeSurfaceHero
}

export const DEFAULT_WELCOME_SUGGESTIONS = [
  {
    id: 'fallback-plan-day',
    title: '规划今天的工作',
    prompt: '帮我梳理今天最重要的 3 件事，并给出可执行的时间安排。',
  },
  {
    id: 'fallback-summarize-project',
    title: '总结这个项目',
    prompt: '阅读当前工作区，帮我总结项目结构、关键模块和下一步建议。',
  },
  {
    id: 'fallback-debug-path',
    title: '排查一个问题',
    prompt: '我遇到一个问题，请先帮我设计最小复现和排查路径。',
  },
  {
    id: 'fallback-memory-review',
    title: '整理近期记忆',
    prompt: '根据最近对话和项目上下文，帮我提炼需要长期保留的偏好和决策。',
  },
]

export function buildWelcomeSurfaceViewModel({
  workspaceName,
}: BuildWelcomeSurfaceViewModelInput): WelcomeSurfaceViewModel {
  return {
    hero: {
      title: '今天想一起完成什么？',
      subtitle: workspaceName
        ? `在「${workspaceName}」中开始新的工作流`
        : '在当前工作区中开始新的工作流',
    },
  }
}
