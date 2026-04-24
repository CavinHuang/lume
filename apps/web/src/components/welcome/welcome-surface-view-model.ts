import type { AgentThreadMeta } from '@lume/shared'

export const RECENT_THREAD_PANEL_LIMIT = 4
export const RECOMMENDED_WORKFLOW_PANEL_ROWS = 3
export const RECENT_FILE_PANEL_ROWS = 3
export const PRIMARY_WELCOME_CARD_IDS = ['plan', 'ship', 'analyze', 'review'] as const

type PrimaryWelcomeCardId = (typeof PRIMARY_WELCOME_CARD_IDS)[number]

export interface WelcomeSurfaceRecentFile {
  filename: string
  sourcePath: string
  lastUsedAt?: number
}

export interface BuildWelcomeSurfaceViewModelInput {
  workspaceName: string | null
  recentThreads: AgentThreadMeta[]
  recentFiles: WelcomeSurfaceRecentFile[]
}

export interface WelcomeSurfaceHero {
  title: string
  subtitle: string
}

export interface WelcomeSurfacePrimaryCard {
  id: PrimaryWelcomeCardId
  eyebrow: string
  title: string
  description: string
  promptSeed: string
}

export interface WelcomeSurfaceThreadItem {
  kind: 'thread'
  id: string
  title: string
  description: string
  meta: string
}

export interface WelcomeSurfaceWorkflowItem {
  kind: 'workflow'
  id: string
  title: string
  description: string
  promptSeed: string
}

export interface WelcomeSurfaceFileItem {
  kind: 'file' | 'empty'
  id: string
  title: string
  meta: string
  filename?: string
  sourcePath?: string
}

export type WelcomeSurfacePanel =
  | {
      id: 'recent-threads'
      title: string
      subtitle: string
      items: WelcomeSurfaceThreadItem[]
      emptyLabel: string
    }
  | {
      id: 'recommended-workflows'
      title: string
      subtitle: string
      items: WelcomeSurfaceWorkflowItem[]
    }
  | {
      id: 'recent-files'
      title: string
      subtitle: string
      items: WelcomeSurfaceFileItem[]
    }

export interface WelcomeSurfaceViewModel {
  hero: WelcomeSurfaceHero
  primaryCards: WelcomeSurfacePrimaryCard[]
  lowerPanels: WelcomeSurfacePanel[]
}

const primaryCards: WelcomeSurfacePrimaryCard[] = [
  {
    id: 'plan',
    eyebrow: 'Workflow',
    title: '整理产品需求',
    description: '梳理需求要点，输出 PRD 大纲和功能清单。',
    promptSeed: '请帮我整理产品需求，梳理核心目标、用户场景、PRD 大纲和功能清单。',
  },
  {
    id: 'ship',
    eyebrow: 'Build',
    title: '分析代码结构',
    description: '解读项目结构，生成模块依赖图和优化建议。',
    promptSeed: '请先分析当前项目的代码结构、模块依赖和关键风险，并给出优化建议。',
  },
  {
    id: 'analyze',
    eyebrow: 'Insight',
    title: '生成发布清单',
    description: '基于变更内容，生成发布说明和验证清单。',
    promptSeed: '请根据当前变更生成发布说明、验证清单和交付前检查项。',
  },
  {
    id: 'review',
    eyebrow: 'Quality',
    title: '优化 UI 设计系统',
    description: '提出设计系统改进建议，统一组件与视觉语言。',
    promptSeed: '请帮我审视当前 UI 设计系统，提出组件、布局、色彩和交互的一致性优化建议。',
  },
]

const recommendedWorkflows: WelcomeSurfaceWorkflowItem[] = [
  {
    kind: 'workflow',
    id: 'deep-interview',
    title: '深挖需求边界',
    description: '适合目标仍然模糊、需要先澄清范围的时候。',
    promptSeed: '通过一轮深度访谈，帮我把这个需求的边界、约束和成功标准澄清出来。',
  },
  {
    kind: 'workflow',
    id: 'ralplan',
    title: '共识规划',
    description: '把设计、测试和交付节奏整理成团队可执行方案。',
    promptSeed: '请先给我一份包含实现顺序、风险和测试策略的共识计划。',
  },
  {
    kind: 'workflow',
    id: 'code-review',
    title: '交付前代码审查',
    description: '优先寻找行为回归、风险点和缺失测试。',
    promptSeed: '以代码审查模式检查我的改动，重点找行为风险、回归和缺失测试。',
  },
]

export function buildWelcomeSurfaceViewModel({
  workspaceName,
  recentThreads,
  recentFiles,
}: BuildWelcomeSurfaceViewModelInput): WelcomeSurfaceViewModel {
  return {
    hero: {
      title: '今天想一起完成什么？',
      subtitle: workspaceName
        ? `在「${workspaceName}」中开始新的工作流`
        : '在当前工作区中开始新的工作流',
    },
    primaryCards,
    lowerPanels: [
      {
        id: 'recent-threads',
        title: '最近会话',
        subtitle: '回到刚才正在推进的上下文',
        emptyLabel: '还没有最近会话，从下方输入区开始一次新的协作。',
        items: [...recentThreads]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, RECENT_THREAD_PANEL_LIMIT)
          .map((thread) => ({
            kind: 'thread',
            id: thread.id,
            title: clampText(thread.title, 28),
            description: buildThreadDescription(thread.title),
            meta: formatRelativeTime(thread.updatedAt),
          })),
      },
      {
        id: 'recommended-workflows',
        title: '推荐工作流',
        subtitle: '从常用入口直接开始，少走一点空路',
        items: recommendedWorkflows.slice(0, RECOMMENDED_WORKFLOW_PANEL_ROWS),
      },
      {
        id: 'recent-files',
        title: '最近文件',
        subtitle: '保持当前资料上下文，文件接入后会出现在这里',
        items: buildRecentFileItems(recentFiles),
      },
    ],
  }
}

function buildRecentFileItems(recentFiles: WelcomeSurfaceRecentFile[]): WelcomeSurfaceFileItem[] {
  const items = recentFiles.slice(0, RECENT_FILE_PANEL_ROWS).map<WelcomeSurfaceFileItem>((file, index) => ({
    kind: 'file',
    id: `file:${index}:${file.sourcePath}`,
    title: clampText(file.filename, 24),
    meta: file.lastUsedAt ? formatRelativeTime(file.lastUsedAt) : simplifyPath(file.sourcePath),
    filename: file.filename,
    sourcePath: file.sourcePath,
  }))

  while (items.length < RECENT_FILE_PANEL_ROWS) {
    items.push({
      kind: 'empty',
      id: `empty:${items.length}`,
      title: '暂无最近文件',
      meta: '添加附件后，这里会保留稳定的文件槽位。',
    })
  }

  return items
}

function clampText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function buildThreadDescription(title: string): string {
  return clampText(`继续推进「${title}」相关上下文`, 34)
}

function simplifyPath(sourcePath: string): string {
  const parts = sourcePath.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 1) return sourcePath
  return parts.slice(-2).join('/')
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)

  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString('zh-CN')
}
