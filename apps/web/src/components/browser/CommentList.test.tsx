import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentBrowserAnnotationAttachment } from '@lume/shared'
import { CommentList, deriveThreads } from './CommentList'

// 构造最小可用 annotation（覆盖必填字段，其余通过 overrides）
function makeAnnotation(overrides: Partial<AgentBrowserAnnotationAttachment> = {}): AgentBrowserAnnotationAttachment {
  return {
    id: 'a1',
    origin: 'browser-annotation',
    tab: {
      id: 'tab',
      origin: 'browser-tab',
      tabId: 'tab',
      ownerThreadId: 'thread-1',
      title: 'Example',
      url: 'https://example.test/',
    },
    anchor: {
      kind: 'element',
      url: 'https://example.test/',
      generation: 1,
      framePath: [],
      rect: { x: 0, y: 0, width: 1, height: 1 },
    },
    body: 'Review this',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('deriveThreads — 分组扁平 comments', () => {
  test('空输入返回空数组', () => {
    expect(deriveThreads([])).toEqual([])
  })

  test('单条无 reviewThreadId 的 comment 自成一线程（key 落到 id）', () => {
    const a = makeAnnotation({ id: 'a1' })
    const threads = deriveThreads([a])
    expect(threads).toHaveLength(1)
    expect(threads[0].reviewThreadId).toBe('a1')
    expect(threads[0].root.id).toBe('a1')
    expect(threads[0].replies).toEqual([])
    expect(threads[0].isResolved).toBe(false)
    expect(threads[0].unreadCount).toBe(1)
  })

  test('共享 reviewThreadId 的 comments 合并为同一线程', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1', createdAt: '2026-08-01T00:00:00.000Z' })
    const reply = makeAnnotation({
      id: 'r2',
      reviewThreadId: 't1',
      inReplyToId: 'r1',
      createdAt: '2026-08-01T01:00:00.000Z',
      body: 'Reply',
    })
    const threads = deriveThreads([root, reply])
    expect(threads).toHaveLength(1)
    expect(threads[0].reviewThreadId).toBe('t1')
    expect(threads[0].root.id).toBe('r1')
    expect(threads[0].replies.map((r) => r.id)).toEqual(['r2'])
  })

  test('不同 reviewThreadId 形成独立线程', () => {
    const a = makeAnnotation({ id: 'a1', reviewThreadId: 't1' })
    const b = makeAnnotation({ id: 'b1', reviewThreadId: 't2' })
    const threads = deriveThreads([a, b])
    expect(threads).toHaveLength(2)
    expect(threads.map((t) => t.reviewThreadId).sort()).toEqual(['t1', 't2'])
  })

  test('reply 仅含 inReplyToId（无 reviewThreadId）时归属父评论所在线程', () => {
    const root = makeAnnotation({ id: 'r1', createdAt: '2026-08-01T00:00:00.000Z' })
    const reply = makeAnnotation({
      id: 'r2',
      inReplyToId: 'r1',
      createdAt: '2026-08-01T01:00:00.000Z',
      body: 'Reply',
    })
    const threads = deriveThreads([root, reply])
    expect(threads).toHaveLength(1)
    expect(threads[0].root.id).toBe('r1')
    expect(threads[0].replies.map((r) => r.id)).toEqual(['r2'])
  })

  test('root 选择：组内无 inReplyToId 的最早 comment 优先；乱序输入仍正确', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1', createdAt: '2026-08-01T00:00:00.000Z' })
    const reply = makeAnnotation({
      id: 'r2',
      reviewThreadId: 't1',
      inReplyToId: 'r1',
      createdAt: '2026-08-01T01:00:00.000Z',
    })
    const threads = deriveThreads([reply, root])
    expect(threads[0].root.id).toBe('r1')
    expect(threads[0].replies.map((r) => r.id)).toEqual(['r2'])
  })

  test('replies 按 createdAt 升序排列', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1', createdAt: '2026-08-01T00:00:00.000Z' })
    const older = makeAnnotation({
      id: 'ro',
      reviewThreadId: 't1',
      inReplyToId: 'r1',
      createdAt: '2026-08-01T00:30:00.000Z',
      body: 'older',
    })
    const newer = makeAnnotation({
      id: 'rn',
      reviewThreadId: 't1',
      inReplyToId: 'r1',
      createdAt: '2026-08-01T00:10:00.000Z',
      body: 'newer',
    })
    const threads = deriveThreads([root, older, newer])
    expect(threads[0].replies.map((r) => r.id)).toEqual(['rn', 'ro'])
  })

  test('线程整体按 root.createdAt 升序输出', () => {
    const later = makeAnnotation({ id: 'a1', reviewThreadId: 't1', createdAt: '2026-08-02T00:00:00.000Z' })
    const earlier = makeAnnotation({ id: 'a2', reviewThreadId: 't2', createdAt: '2026-08-01T00:00:00.000Z' })
    const threads = deriveThreads([later, earlier])
    expect(threads.map((t) => t.reviewThreadId)).toEqual(['t2', 't1'])
  })

  test('isResolved：组内任一 comment.isResolved=true 即整线已解决', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1' })
    const reply = makeAnnotation({
      id: 'r2',
      reviewThreadId: 't1',
      inReplyToId: 'r1',
      isResolved: true,
      resolvedAt: '2026-08-02T00:00:00.000Z',
      resolvedBy: 'user',
    })
    const threads = deriveThreads([root, reply])
    expect(threads[0].isResolved).toBe(true)
  })

  test('unreadCount：!readAt && !isResolved 计入未读；resolved 不计', () => {
    const rootUnread = makeAnnotation({ id: 'r1', reviewThreadId: 't1' })
    const replyRead = makeAnnotation({
      id: 'r2',
      reviewThreadId: 't1',
      inReplyToId: 'r1',
      readAt: '2026-08-02T00:00:00.000Z',
    })
    const resolved = makeAnnotation({ id: 'r3', reviewThreadId: 't3', isResolved: true })
    const threads = deriveThreads([rootUnread, replyRead, resolved])
    expect(threads.find((t) => t.reviewThreadId === 't1')?.unreadCount).toBe(1)
    expect(threads.find((t) => t.reviewThreadId === 't3')?.unreadCount).toBe(0)
  })

  // Task 94 reviewer 3 Issue 1：线程整体已解决（任一 comment.isResolved）时，即便组内其它
  // comment 未置 isResolved / 未读，整线 unreadCount 也应归零（避免「已解决」+「N 未读」并存）。
  test('线程整体 isResolved 时 unreadCount 强制归零（即便组内其它 comment 未读）', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1' }) // 未读、未 resolve
    const replyResolved = makeAnnotation({
      id: 'r2',
      reviewThreadId: 't1',
      inReplyToId: 'r1',
      isResolved: true,
      resolvedAt: '2026-08-02T00:00:00.000Z',
      resolvedBy: 'user',
    })
    const threads = deriveThreads([root, replyResolved])
    expect(threads[0]!.isResolved).toBe(true)
    expect(threads[0]!.unreadCount).toBe(0) // 关键：整线 resolved → 归零，不是 1
  })
})

describe('CommentList 渲染', () => {
  test('空列表展示占位文案', () => {
    const markup = renderToStaticMarkup(<CommentList comments={[]} />)
    expect(markup).toContain('data-comment-list')
    expect(markup).toContain('暂无评论')
  })

  test('渲染分组线程与 root 正文', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1', body: '请检查这个按钮' })
    const markup = renderToStaticMarkup(<CommentList comments={[root]} />)
    expect(markup).toContain('data-comment-list')
    expect(markup).toContain('data-comment-thread')
    expect(markup).toContain('请检查这个按钮')
  })

  test('已解决线程展示「已解决」徽章且默认折叠（replies 正文不出现）', () => {
    const root = makeAnnotation({
      id: 'r1',
      reviewThreadId: 't1',
      isResolved: true,
      body: '已解决的主评论',
    })
    const reply = makeAnnotation({
      id: 'r2',
      reviewThreadId: 't1',
      inReplyToId: 'r1',
      body: '这条回复在折叠态下不应渲染',
    })
    const markup = renderToStaticMarkup(<CommentList comments={[root, reply]} />)
    expect(markup).toContain('已解决')
    // 折叠态：replies 的正文不应出现在初始 markup
    expect(markup).not.toContain('这条回复在折叠态下不应渲染')
    // root 正文依然出现（折叠的是 replies 区，root 始终可见）
    expect(markup).toContain('已解决的主评论')
  })

  test('未解决线程默认展开，root 与 replies 正文均渲染', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1', body: '主评论可见' })
    const reply = makeAnnotation({
      id: 'r2',
      reviewThreadId: 't1',
      inReplyToId: 'r1',
      body: '回复可见',
    })
    const markup = renderToStaticMarkup(<CommentList comments={[root, reply]} />)
    expect(markup).toContain('主评论可见')
    expect(markup).toContain('回复可见')
  })

  test('线程含未读时展示未读计数徽标', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1', body: 'unread' })
    const markup = renderToStaticMarkup(<CommentList comments={[root]} />)
    expect(markup).toContain('data-comment-unread')
    expect(markup).toContain('1')
  })

  test('线程全部已读时不渲染未读徽标', () => {
    const root = makeAnnotation({
      id: 'r1',
      reviewThreadId: 't1',
      body: 'read',
      readAt: '2026-08-02T00:00:00.000Z',
    })
    const markup = renderToStaticMarkup(<CommentList comments={[root]} />)
    expect(markup).not.toContain('data-comment-unread')
  })

  test('author.kind 标签区分 user 与 agent', () => {
    const userComment = makeAnnotation({
      id: 'u1',
      reviewThreadId: 'tu',
      body: 'user body',
      author: { kind: 'user', name: 'Alice' },
    })
    const agentComment = makeAnnotation({
      id: 'a1',
      reviewThreadId: 'ta',
      body: 'agent body',
      author: { kind: 'agent' },
    })
    const markup = renderToStaticMarkup(<CommentList comments={[userComment, agentComment]} />)
    expect(markup).toContain('用户')
    expect(markup).toContain('Agent')
  })

  test('author.name 缺失时仍渲染 kind 标签', () => {
    const userComment = makeAnnotation({
      id: 'u1',
      reviewThreadId: 'tu',
      body: 'body',
      author: { kind: 'user' },
    })
    const markup = renderToStaticMarkup(<CommentList comments={[userComment]} />)
    expect(markup).toContain('用户')
  })

  test('传入 onResolve 时渲染「解决」按钮', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1' })
    const markup = renderToStaticMarkup(
      <CommentList comments={[root]} onResolve={() => undefined} />,
    )
    expect(markup).toContain('data-comment-action="resolve"')
  })

  test('未传 onResolve 时不渲染「解决」按钮', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1' })
    const markup = renderToStaticMarkup(<CommentList comments={[root]} />)
    expect(markup).not.toContain('data-comment-action="resolve"')
  })

  test('传入 onMarkRead 且线程含未读时渲染「标记已读」按钮', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1' })
    const markup = renderToStaticMarkup(
      <CommentList comments={[root]} onMarkRead={() => undefined} />,
    )
    expect(markup).toContain('data-comment-action="mark-read"')
  })

  test('未传 onMarkRead 时不渲染「标记已读」按钮', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1' })
    const markup = renderToStaticMarkup(<CommentList comments={[root]} />)
    expect(markup).not.toContain('data-comment-action="mark-read"')
  })

  test('已解决线程不渲染「解决」按钮（避免重复解决）', () => {
    const root = makeAnnotation({ id: 'r1', reviewThreadId: 't1', isResolved: true })
    const markup = renderToStaticMarkup(
      <CommentList comments={[root]} onResolve={() => undefined} />,
    )
    expect(markup).not.toContain('data-comment-action="resolve"')
  })
})
