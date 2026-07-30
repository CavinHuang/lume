import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertTriangle, Copy } from 'lucide-react'
import { AGENT_IPC_CHANNELS, type AgentDiffCommentAttachment, type CodingBlameResult } from '@lume/shared'
import type { DiffLineAnnotation, LineAnnotation, PostRenderPhase, SelectedLineRange } from '@pierre/diffs'
import { createPierreFileDiff, PierreDiffView, PierreFileView } from '@/components/diff/PierreDiffView'
import { normalizeDiffSnippet } from '@/components/diff/diff-normalize'
import type { ThreadFileLineSelection } from '@/components/agent/thread-file-links'
import { agentDiffCommentDraftsAtom, agentDiffCommentDraftsFamily, agentRuntimeEventsFamily } from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { sidecarCall, writeClipboardText } from '@/lib/desktop-api'

type SourceCommentAnnotation =
  | { kind: 'comment-editor' }
  | { kind: 'readonly-comment'; comment: AgentDiffCommentAttachment; pending: boolean }

export function RightPanelSourcePreview({
  threadId,
  content,
  filePath,
  lineSelection,
  navigationRevision,
  onLineSelected,
  blameEnabled = false,
}: {
  threadId?: string
  content: string
  filePath: string
  lineSelection?: ThreadFileLineSelection
  navigationRevision?: number
  onLineSelected?: (range: SelectedLineRange | null) => void
  blameEnabled?: boolean
}) {
  const [blame, setBlame] = useState<CodingBlameResult>({ available: false, lines: [] })
  const [localSelection, setLocalSelection] = useState<SelectedLineRange | null>(null)
  const [commentRange, setCommentRange] = useState<SelectedLineRange | null>(null)
  const [commentText, setCommentText] = useState('')
  const commentDrafts = useAtomValue(agentDiffCommentDraftsFamily(threadId ?? '')) ?? []
  const runtimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId ?? ''))?.events ?? []
  const setCommentDrafts = useSetAtom(agentDiffCommentDraftsAtom)
  const lineCount = useMemo(() => content.replace(/\r\n?/g, '\n').split('\n').length, [content])
  const selectionOutOfRange = Boolean(lineSelection && lineSelection.end > lineCount)
  const selectedLines = useMemo<SelectedLineRange | null>(() => {
    if (!lineSelection || selectionOutOfRange) return localSelection
    return { start: lineSelection.start, end: lineSelection.end }
  }, [lineSelection, localSelection, selectionOutOfRange])
  const relatedComments = useMemo(() => {
    const matches = (comment: AgentDiffCommentAttachment) => (
      comment.position.path.replace(/\\/g, '/') === filePath.replace(/\\/g, '/')
    )
    const sent = runtimeEvents.flatMap((event) => (
      event.type === 'message.user.submitted' ? event.commentAttachments ?? [] : []
    )).filter(matches)
    const uniqueSent = [...new Map(sent.map((comment) => [comment.id, comment])).values()]
    return [
      ...commentDrafts.filter(matches).map((comment) => ({ comment, pending: true })),
      ...uniqueSent.filter((comment) => !commentDrafts.some((draft) => draft.id === comment.id))
        .map((comment) => ({ comment, pending: false })),
    ]
  }, [commentDrafts, filePath, runtimeEvents])
  const lineAnnotations = useMemo<LineAnnotation<SourceCommentAnnotation>[]>(() => [
    ...(commentRange ? [{ lineNumber: commentRange.end, metadata: { kind: 'comment-editor' } as const }] : []),
    ...relatedComments.map(({ comment, pending }) => ({
      lineNumber: comment.position.line,
      metadata: { kind: 'readonly-comment' as const, comment, pending },
    })),
  ], [commentRange, relatedComments])
  const diffLineAnnotations = useMemo<DiffLineAnnotation<SourceCommentAnnotation>[]>(() => {
    const annotations: DiffLineAnnotation<SourceCommentAnnotation>[] = []
    if (commentRange) {
      annotations.push({
        side: (commentRange.endSide ?? commentRange.side) === 'deletions' ? 'deletions' : 'additions',
        lineNumber: commentRange.end,
        metadata: { kind: 'comment-editor' },
      })
    }
    for (const { comment, pending } of relatedComments) {
      annotations.push({
        side: comment.position.side === 'left' ? 'deletions' : 'additions',
        lineNumber: comment.position.line,
        metadata: { kind: 'readonly-comment', comment, pending },
      })
    }
    return annotations
  }, [commentRange, relatedComments])
  const patchResult = useMemo(() => {
    if (!/\.(?:diff|patch)$/i.test(filePath)) return null
    try {
      const patch = normalizeDiffSnippet(content, filePath)
      createPierreFileDiff({ patch, filePath })
      return { patch, error: null }
    } catch (error) {
      return { patch: null, error: error instanceof Error ? error.message : 'Diff 解析失败' }
    }
  }, [content, filePath])
  useEffect(() => {
    if (!blameEnabled || !threadId) {
      setBlame({ available: false, lines: [] })
      return
    }
    let cancelled = false
    void sidecarCall<CodingBlameResult>(AGENT_IPC_CHANNELS.GET_CODING_BLAME, {
      threadId,
      path: filePath,
    }).then((result) => {
      if (!cancelled) setBlame(result)
    }).catch(() => {
      if (!cancelled) setBlame({ available: false, lines: [] })
    })
    return () => { cancelled = true }
  }, [blameEnabled, content, filePath, threadId])
  const handlePostRender = useCallback((node: HTMLElement, _instance: unknown, phase: PostRenderPhase) => {
    if (phase === 'unmount') return
    if (selectedLines) {
      node.querySelector<HTMLElement>(`[data-line="${selectedLines.start}"]`)?.scrollIntoView({ block: 'center' })
    }
    if (!blameEnabled || !blame.available) return
    const byLine = new Map(blame.lines.map((line) => [line.lineNumber, line]))
    for (const row of node.querySelectorAll<HTMLElement>('[data-line]')) {
      row.querySelector('[data-lume-blame]')?.remove()
      const line = byLine.get(Number(row.dataset.line))
      const number = row.querySelector<HTMLElement>('[data-line-number-content]')
      if (!line || !number) continue
      const label = document.createElement('span')
      label.dataset.lumeBlame = ''
      label.textContent = line.committed ? line.author : '未提交'
      label.title = [
        line.committed ? line.commit.slice(0, 8) : '未提交',
        line.author,
        line.authorTime ? new Date(line.authorTime).toLocaleString() : '',
        line.summary ?? '',
        line.commitUrl ?? '',
      ].filter(Boolean).join(' · ')
      number.prepend(label)
    }
  }, [blame, blameEnabled, navigationRevision, selectedLines])
  const openComment = (range: SelectedLineRange | null) => {
    setLocalSelection(range)
    setCommentRange(range)
    onLineSelected?.(range)
  }
  const closeComment = () => {
    setCommentRange(null)
    setLocalSelection(null)
    setCommentText('')
  }
  const saveComment = () => {
    if (!threadId || !commentRange || !commentText.trim()) return
    const attachment: AgentDiffCommentAttachment = {
      id: crypto.randomUUID(),
      origin: 'diff',
      position: {
        path: filePath,
        side: (commentRange.endSide ?? commentRange.side) === 'deletions' ? 'left' : 'right',
        line: commentRange.end,
        startLine: commentRange.start,
        startSide: commentRange.side === 'deletions' ? 'left' : 'right',
      },
      body: commentText.trim(),
      localDiffHunk: content.replace(/\r\n?/g, '\n').split('\n')
        .slice(Math.max(0, commentRange.start - 2), Math.min(lineCount, commentRange.end + 1))
        .map((line, index) => `${Math.max(1, commentRange.start - 1) + index}: ${line}`)
        .join('\n'),
    }
    setCommentDrafts((current) => ({
      ...current,
      [threadId]: [...(current[threadId] ?? []), attachment],
    }))
    closeComment()
  }
  const renderCommentEditor = (annotation: LineAnnotation<SourceCommentAnnotation> | DiffLineAnnotation<SourceCommentAnnotation>) => (
    annotation.metadata.kind === 'readonly-comment' ? (
      <div className="m-2 rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] px-3 py-2 text-xs text-[var(--lume-text-secondary)]">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--lume-text-muted)]">
          {annotation.metadata.pending ? '待发送的审阅意见' : '已发送的审阅意见'}
        </div>
        <p className="m-0 whitespace-pre-wrap">{annotation.metadata.comment.body}</p>
      </div>
    ) : <div className="m-2 rounded-lg border border-[var(--lume-border-strong)] bg-[var(--lume-bg-elevated)] p-2 shadow-sm">
      <Textarea
        value={commentText}
        onChange={(event) => setCommentText(event.target.value)}
        placeholder="留下审阅意见…"
        className="min-h-16 resize-y text-xs"
        autoFocus
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <Button variant="ghost" size="xs" onClick={closeComment}>取消</Button>
        <Button size="xs" disabled={!commentText.trim()} onClick={saveComment}>添加意见</Button>
      </div>
    </div>
  )

  return (
    <div className="min-h-full min-w-full">
      {selectionOutOfRange && (
        <p role="status" className="m-0 border-b border-amber-500/20 bg-amber-500/8 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
          无法定位 L{lineSelection!.start}{lineSelection!.end === lineSelection!.start ? '' : `–L${lineSelection!.end}`}：当前可读内容只有 {lineCount} 行。
        </p>
      )}
      {patchResult?.patch ? (
        <PierreDiffView<SourceCommentAnnotation>
          patch={patchResult.patch}
          filePath={filePath}
          expandUnchanged
          selectedLines={selectedLines}
          lineAnnotations={diffLineAnnotations}
          enableLineSelection
          enableGutterUtility={Boolean(threadId)}
          onLineSelected={openComment}
          onLineSelectionChange={setLocalSelection}
          onGutterUtilityClick={openComment}
          renderAnnotation={renderCommentEditor}
        />
      ) : patchResult ? (
        <div className="m-3 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle size={14} />
          <span className="min-w-0 flex-1">{patchResult.error}</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => void writeClipboardText(content)}>
            <Copy size={12} />
            复制原文
          </Button>
        </div>
      ) : (
      <PierreFileView<SourceCommentAnnotation>
        content={content}
        filePath={filePath}
        selectedLines={selectedLines}
        lineAnnotations={lineAnnotations}
        enableGutterUtility={Boolean(threadId)}
        onLineSelected={openComment}
        onGutterUtilityClick={openComment}
        renderAnnotation={renderCommentEditor}
        onPostRender={handlePostRender as never}
        unsafeCSS={blameEnabled ? `
          [data-line-number-content] { min-width: 11rem; }
          [data-lume-blame] {
            display: inline-block;
            width: 7.5rem;
            margin-right: .5rem;
            overflow: hidden;
            color: var(--lume-text-muted);
            text-overflow: ellipsis;
            vertical-align: bottom;
            white-space: nowrap;
          }
        ` : undefined}
      />
      )}
    </div>
  )
}
