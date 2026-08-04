import { useEffect, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import type { AgentBrowserAnnotationAttachment } from '@lume/shared'

// ===== 线程派生 =====

/**
 * 一个评论线程：root + replies（扁平结构，对齐 Codex PR diff 评审模型）。
 */
export interface CommentThread {
  /** 线程组 id（同 reviewThreadId 的 comments 归属同一线程） */
  reviewThreadId: string
  /** 线程根评论（组内无 inReplyToId 的最早 comment） */
  root: AgentBrowserAnnotationAttachment
  /** 线程回复（inReplyToId 指向 root 或共享 reviewThreadId） */
  replies: AgentBrowserAnnotationAttachment[]
  /** 整线是否已解决（组内任一 comment.isResolved 即整线已解决） */
  isResolved: boolean
  /** 未读计数：!readAt && !isResolved 的 comment 数（线程整体已解决时归零） */
  unreadCount: number
}

/**
 * 按 reviewThreadId 分组扁平 comments（Codex 同策略，不嵌套 replies 数组）。
 *
 * 分组键：
 * 1. 显式 reviewThreadId → 同 id 合并
 * 2. 仅 inReplyToId（无 reviewThreadId）→ 归属父评论（id 匹配）所在线程
 * 3. 都缺失 → 自成一线程（key = 自身 id）
 *
 * 派生：
 * - root = 组内无 inReplyToId 的最早 comment；都缺失时回退到最早 comment
 * - replies = 组内其余 comment（按 createdAt 升序）
 * - isResolved = 组内任一 comment.isResolved === true
 * - unreadCount = 组内 !readAt && !isResolved 的 comment 数；线程整体已解决时强制归零
 *
 * 输出按 root.createdAt 升序。
 *
 * 限制（reply chain）：inReplyToId 仅做单跳分组——无 reviewThreadId 时查父评论的
 * reviewThreadId ?? parent.id 即止，不再沿 inReplyToId 链向上递归。多级 reply-of-reply
 * 应携带显式 reviewThreadId（推荐做法），否则会被分到与父评论同组（仍是合理的「同线程」语义，
 * 仅 root 选择可能落到中间回复）。Codex 实证也是单跳，本实现与之对齐。
 */
export function deriveThreads(comments: AgentBrowserAnnotationAttachment[]): CommentThread[] {
  if (comments.length === 0) return []

  const byId = new Map<string, AgentBrowserAnnotationAttachment>()
  for (const comment of comments) byId.set(comment.id, comment)

  // 计算单条 comment 归属的线程 key
  const threadKeyOf = (comment: AgentBrowserAnnotationAttachment): string => {
    if (comment.reviewThreadId) return comment.reviewThreadId
    if (comment.inReplyToId && byId.has(comment.inReplyToId)) {
      const parent = byId.get(comment.inReplyToId)!
      // 父的线程 key（父必有 reviewThreadId 或回退到父 id；不再递归）
      return parent.reviewThreadId ?? parent.id
    }
    return comment.id
  }

  // 分组（保留输入顺序）
  const groups = new Map<string, AgentBrowserAnnotationAttachment[]>()
  for (const comment of comments) {
    const key = threadKeyOf(comment)
    const list = groups.get(key)
    if (list) list.push(comment)
    else groups.set(key, [comment])
  }

  // 派生每个线程
  const threads: CommentThread[] = []
  for (const [reviewThreadId, group] of groups) {
    const sorted = [...group].sort(compareByCreatedAt)
    const explicitRoot = sorted.find((c) => !c.inReplyToId) ?? sorted[0]
    const replies = sorted.filter((c) => c.id !== explicitRoot.id)
    const isResolved = group.some((c) => c.isResolved === true)
    // 线程整体已解决时强制 unreadCount = 0：resolved 是整线语义，单条 comment 未置
    // isResolved 也不应保留未读徽标（避免「已解决」+「N 条未读」同时出现）。
    const unreadCount = isResolved ? 0 : group.filter((c) => !c.readAt && !c.isResolved).length
    threads.push({ reviewThreadId, root: explicitRoot, replies, isResolved, unreadCount })
  }

  threads.sort((a, b) => compareByCreatedAt(a.root, b.root))
  return threads
}

function compareByCreatedAt(a: AgentBrowserAnnotationAttachment, b: AgentBrowserAnnotationAttachment): number {
  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
}

// ===== CommentList 组件 =====

export interface CommentListProps {
  comments: AgentBrowserAnnotationAttachment[]
  /** 解决线程回调（点击「解决」按钮触发，传入线程根评论 id——store resolveComment 按 annotationId 翻字段） */
  onResolve?: (rootAnnotationId: string) => void
  /** 标记线程已读回调（传入线程根评论 id——store markRead 按 annotationId 翻字段） */
  onMarkRead?: (rootAnnotationId: string) => void
}

/**
 * 右栏评论列表面板：
 * - 按 reviewThreadId 分组渲染线程
 * - 已解决线程默认折叠 + 「已解决」徽章
 * - 未解决线程默认展开（root + replies）
 * - 未读计数徽标（!readAt && !isResolved）
 * - author 区分 user / agent
 */
export function CommentList({ comments, onResolve, onMarkRead }: CommentListProps) {
  const threads = deriveThreads(comments)

  if (threads.length === 0) {
    return (
      <div data-comment-list="true" className="flex flex-col gap-2 py-6 text-center text-sm text-[var(--lume-text-muted)]">
        暂无评论
      </div>
    )
  }

  return (
    <div data-comment-list="true" className="flex flex-col gap-2">
      {threads.map((thread) => (
        <CommentThreadItem
          key={thread.reviewThreadId}
          thread={thread}
          onResolve={onResolve}
          onMarkRead={onMarkRead}
        />
      ))}
    </div>
  )
}

// ===== 单个线程项 =====

interface CommentThreadItemProps {
  thread: CommentThread
  onResolve?: (rootAnnotationId: string) => void
  onMarkRead?: (rootAnnotationId: string) => void
}

function CommentThreadItem({ thread, onResolve, onMarkRead }: CommentThreadItemProps) {
  // resolved 默认折叠（对齐 Codex PR defaultCollapsed + resolved badge）
  const [collapsed, setCollapsed] = useState(thread.isResolved)

  // 跟随 props：线程 resolved 状态变化时同步折叠态（resolve → 折叠；reopen → 展开）。
  // 用户手动 toggle 后仍可在最新 isResolved 趋势到来时被覆盖，与 Codex PR 面板行为一致。
  useEffect(() => {
    setCollapsed(thread.isResolved)
  }, [thread.isResolved])

  const toggleCollapsed = () => setCollapsed((value) => !value)
  // 传 root.id（线程根评论的 annotationId）：store resolveComment/markRead 按 annotationId
  // 翻字段；root 被置 isResolved 后 deriveThreads.group.some 会让整线显示已解决。
  const handleResolve = () => onResolve?.(thread.root.id)
  const handleMarkRead = () => onMarkRead?.(thread.root.id)

  return (
    <div
      data-comment-thread="true"
      data-comment-resolved={thread.isResolved ? 'true' : 'false'}
      className="flex flex-col gap-1.5 rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-2.5 text-sm"
    >
      <div className="flex items-center gap-1.5 text-xs text-[var(--lume-text-muted)]">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? '展开线程' : '折叠线程'}
          className="flex size-4 items-center justify-center text-[var(--lume-text-muted)] hover:text-[var(--lume-text-primary)]"
        >
          <ChevronRight
            size={12}
            className={collapsed ? '' : 'rotate-90'}
          />
        </button>
        <CommentAuthor author={thread.root.author} />
        {thread.isResolved && (
          <span className="rounded-full bg-[color:color-mix(in_oklab,var(--lume-accent-primary)_18%,transparent)] px-2 py-0.5 text-[11px] font-medium text-[var(--lume-accent-primary)]">
            已解决
          </span>
        )}
        {thread.unreadCount > 0 && (
          <span
            data-comment-unread="true"
            className="ml-auto rounded-full bg-[var(--lume-accent-primary)] px-1.5 py-0.5 text-[11px] font-semibold text-white"
          >
            {thread.unreadCount}
          </span>
        )}
      </div>

      <div className="text-[var(--lume-text-primary)]">{thread.root.body}</div>

      {!collapsed && thread.replies.length > 0 && (
        <div className="mt-1 flex flex-col gap-1.5 border-l border-[var(--lume-border-subtle)] pl-2.5">
          {thread.replies.map((reply) => (
            <div key={reply.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-xs text-[var(--lume-text-muted)]">
                <CommentAuthor author={reply.author} />
              </div>
              <div className="text-[var(--lume-text-primary)]">{reply.body}</div>
            </div>
          ))}
        </div>
      )}

      {((onResolve && !thread.isResolved) || (onMarkRead && thread.unreadCount > 0)) && (
        <div className="mt-1 flex items-center gap-1.5">
          {onResolve && !thread.isResolved && (
            <button
              type="button"
              data-comment-action="resolve"
              onClick={handleResolve}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-rail)] hover:text-[var(--lume-text-primary)]"
            >
              <Check size={12} />
              解决
            </button>
          )}
          {onMarkRead && thread.unreadCount > 0 && (
            <button
              type="button"
              data-comment-action="mark-read"
              onClick={handleMarkRead}
              className="rounded-md px-2 py-1 text-xs text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-rail)] hover:text-[var(--lume-text-primary)]"
            >
              标记已读
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ===== author 标签 =====

function CommentAuthor({ author }: { author?: AgentBrowserAnnotationAttachment['author'] }) {
  if (!author) return null
  const label = author.kind === 'user' ? '用户' : 'Agent'
  return (
    <span className="font-medium text-[var(--lume-text-primary)]">
      {author.name ?? label}
      <span className="ml-1 rounded bg-[var(--lume-bg-rail)] px-1 py-0.5 text-[10px] font-normal text-[var(--lume-text-muted)]">
        {label}
      </span>
    </span>
  )
}
