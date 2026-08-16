import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAtomValue, useSetAtom } from 'jotai'
import { AlertTriangle, Check, Copy, LoaderCircle, Pencil, X } from 'lucide-react'
import {
  AGENT_IPC_CHANNELS,
  type AgentDiffCommentAttachment,
  type CodingBlameLine,
  type CodingBlameResult,
  type FileSelectionEditResult,
  type FileRef,
} from '@lume/shared'
import type { DiffLineAnnotation, LineAnnotation, PostRenderPhase, SelectedLineRange } from '@pierre/diffs'
import type { Editor, EditorOptions, Range } from '@pierre/diffs/edit'
import { createPierreFileDiff, PierreDiffView, PierreEditableFileView, PierreFileView } from '@/components/diff/PierreDiffView'
import { normalizeDiffSnippet } from '@/components/diff/diff-normalize'
import type { ThreadFileLineSelection } from '@/components/agent/thread-file-links'
import {
  agentDiffCommentDraftsAtom,
  agentDiffCommentDraftsFamily,
  agentInputDraftAtom,
  agentRuntimeEventsFamily,
} from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { openExternal, sidecarCall, writeClipboardText } from '@/lib/desktop-api'

type SourceCommentAnnotation =
  | { kind: 'comment-editor' }
  | { kind: 'readonly-comment'; comment: AgentDiffCommentAttachment; pending: boolean }
  | { kind: 'selection-edit' }

type SelectionEditState = {
  status: 'draft' | 'pending' | 'review' | 'error'
  range: Range
  lineNumber: number
  selectedText: string
  oldContent: string
  instruction: string
  replacementText?: string
  newContent?: string
  message?: string
}

type SelectionActionContext = Parameters<
  NonNullable<EditorOptions<SourceCommentAnnotation>['renderSelectionAction']>
>[0]

export function RightPanelSourcePreview({
  threadId,
  content,
  filePath,
  fileRef,
  lineSelection,
  navigationRevision,
  onLineSelected,
  blameEnabled = false,
  editable = false,
  editorCacheKey,
  onContentChange,
  onEditorAttach,
  wrapLines = false,
}: {
  threadId?: string
  content: string
  filePath: string
  fileRef?: FileRef
  lineSelection?: ThreadFileLineSelection
  navigationRevision?: number
  onLineSelected?: (range: SelectedLineRange | null) => void
  blameEnabled?: boolean
  editable?: boolean
  wrapLines?: boolean
  editorCacheKey?: string
  onContentChange?: (content: string) => void
  onEditorAttach?: (editor: Editor<SourceCommentAnnotation>) => void
}) {
  const editorRef = useRef<Editor<SourceCommentAnnotation> | null>(null)
  const selectionEditRequestRef = useRef(0)
  const [blame, setBlame] = useState<CodingBlameResult>({ available: false, lines: [] })
  const [expandedBlameLine, setExpandedBlameLine] = useState<number | null>(null)
  const [localSelection, setLocalSelection] = useState<SelectedLineRange | null>(null)
  const [commentRange, setCommentRange] = useState<SelectedLineRange | null>(null)
  const [commentText, setCommentText] = useState('')
  const [selectionEdit, setSelectionEdit] = useState<SelectionEditState | null>(null)
  const commentDrafts = useAtomValue(agentDiffCommentDraftsFamily(threadId ?? '')) ?? []
  const runtimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId ?? ''))?.events ?? []
  const setCommentDrafts = useSetAtom(agentDiffCommentDraftsAtom)
  const setInputDrafts = useSetAtom(agentInputDraftAtom)
  const lineCount = useMemo(() => content.replace(/\r\n?/g, '\n').split('\n').length, [content])
  const selectionOutOfRange = Boolean(lineSelection && lineSelection.end > lineCount)
  const selectedLines = useMemo<SelectedLineRange | null>(() => {
    if (!lineSelection || selectionOutOfRange) return localSelection
    return { start: lineSelection.start, end: lineSelection.end }
  }, [lineSelection, localSelection, selectionOutOfRange])
  const relatedComments = useMemo(() => {
    const matches = (comment: AgentDiffCommentAttachment) => {
      if (fileRef && comment.fileRef) {
        return fileRef.source === comment.fileRef.source
          && fileRef.scopeId === comment.fileRef.scopeId
          && fileRef.relativePath.replace(/\\/g, '/') === comment.fileRef.relativePath.replace(/\\/g, '/')
      }
      return comment.position.path.replace(/\\/g, '/') === filePath.replace(/\\/g, '/')
    }
    const sent = runtimeEvents.flatMap((event) => (
      event.type === 'message.user.submitted' ? event.commentAttachments ?? [] : []
    )).filter((comment) => comment.intent !== 'modify' && matches(comment))
    const uniqueSent = [...new Map(sent.map((comment) => [comment.id, comment])).values()]
    return [
      ...commentDrafts.filter(matches).map((comment) => ({ comment, pending: true })),
      ...uniqueSent.filter((comment) => !commentDrafts.some((draft) => draft.id === comment.id))
        .map((comment) => ({ comment, pending: false })),
    ]
  }, [commentDrafts, filePath, fileRef, runtimeEvents])
  const lineAnnotations = useMemo<LineAnnotation<SourceCommentAnnotation>[]>(() => [
    ...(commentRange ? [{ lineNumber: commentRange.end, metadata: { kind: 'comment-editor' } as const }] : []),
    ...relatedComments.map(({ comment, pending }) => ({
      lineNumber: Math.max(1, Math.min(lineCount, comment.position.line)),
      metadata: { kind: 'readonly-comment' as const, comment, pending },
    })),
    ...(selectionEdit ? [{
      lineNumber: Math.max(1, Math.min(lineCount, selectionEdit.lineNumber)),
      metadata: { kind: 'selection-edit' } as const,
    }] : []),
  ], [commentRange, lineCount, relatedComments, selectionEdit])
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
  const sourceCss = BLAME_CSS
  useEffect(() => {
    if (!blameEnabled || !threadId) {
      setBlame({ available: false, lines: [] })
      setExpandedBlameLine(null)
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
    renderBlameGutters(
      node,
      phase === 'unmount' || !blameEnabled || !blame.available ? [] : blame.lines,
      expandedBlameLine,
      (lineNumber) => setExpandedBlameLine((current) => current === lineNumber ? null : lineNumber),
    )
    if (phase === 'unmount') return
    if (selectedLines) {
      node.querySelector<HTMLElement>(`[data-line="${selectedLines.start}"]`)?.scrollIntoView({ block: 'center' })
    }
  }, [blame.available, blame.lines, blameEnabled, expandedBlameLine, navigationRevision, selectedLines])
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
      intent: 'comment',
      ...(fileRef ? { fileRef } : {}),
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
  const addSelectionToComposer = () => {
    if (!threadId || !commentRange) return
    const selected = content.replace(/\r\n?/g, '\n').split('\n')
      .slice(commentRange.start - 1, commentRange.end)
      .join('\n')
      .slice(0, 32 * 1024)
    const range = commentRange.start === commentRange.end
      ? `L${commentRange.start}`
      : `L${commentRange.start}-L${commentRange.end}`
    const attachment: AgentDiffCommentAttachment = {
      id: crypto.randomUUID(),
      origin: 'diff',
      intent: 'context',
      ...(fileRef ? { fileRef } : {}),
      position: {
        path: filePath,
        side: 'right',
        line: commentRange.end,
        startLine: commentRange.start,
        startSide: 'right',
      },
      body: '将这个文件选区作为上下文。',
      selectedContent: selected,
      localDiffHunk: selected,
    }
    setCommentDrafts((current) => ({
      ...current,
      [threadId]: [...(current[threadId] ?? []), attachment],
    }))
    const text = `请参考 ${filePath}#${range} 中附加的代码选区。`
    setInputDrafts((current) => {
      const existing = current[threadId]
      const paragraph = { type: 'paragraph', content: [{ type: 'text', text }] }
      return {
        ...current,
        [threadId]: {
          type: 'doc',
          content: [...(existing?.content ?? []), paragraph],
        },
      }
    })
    closeComment()
  }
  const openSelectionEdit = useCallback((range: Range, selectedText: string) => {
    const oldContent = editorRef.current?.getText() ?? content
    if (!selectedText || selectedText.length > 32 * 1024) return
    setSelectionEdit({
      status: 'draft',
      range,
      lineNumber: range.end.line + 1,
      selectedText,
      oldContent,
      instruction: '',
    })
    setCommentRange(null)
    setCommentText('')
  }, [content])
  const openLineSelectionEdit = useCallback(() => {
    if (!commentRange) return
    const oldContent = editorRef.current?.getText() ?? content
    const range = lineRangeToEditorRange(oldContent, commentRange)
    openSelectionEdit(range, textForRange(oldContent, range))
  }, [commentRange, content, openSelectionEdit])
  const renderSelectionAction = useCallback((context: SelectionActionContext) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('data-file-selection-action', '')
    button.textContent = '让模型修改'
    button.addEventListener('pointerdown', (event) => event.stopPropagation())
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      openSelectionEdit(context.selection, context.getSelectionText())
      context.close()
    })
    return button
  }, [openSelectionEdit])
  const requestSelectionEdit = useCallback(async () => {
    if (!threadId || !fileRef || !selectionEdit?.instruction.trim()) return
    const editor = editorRef.current
    const oldContent = editor?.getText() ?? content
    const selectedText = textForRange(oldContent, selectionEdit.range)
    if (selectedText !== selectionEdit.selectedText) {
      setSelectionEdit((current) => current ? {
        ...current,
        status: 'error',
        message: '文件已在请求前发生变化，请重新选择要修改的内容。',
      } : current)
      return
    }
    const requestId = ++selectionEditRequestRef.current
    const pending: SelectionEditState = {
      ...selectionEdit,
      status: 'pending',
      oldContent,
      selectedText,
      message: undefined,
    }
    setSelectionEdit(pending)
    try {
      const result = await sidecarCall<FileSelectionEditResult>(
        AGENT_IPC_CHANNELS.REQUEST_FILE_SELECTION_EDIT,
        {
          threadId,
          ref: fileRef,
          content: oldContent,
          startOffset: positionToOffset(oldContent, pending.range.start),
          endOffset: positionToOffset(oldContent, pending.range.end),
          instruction: pending.instruction.trim(),
        },
      )
      if (requestId !== selectionEditRequestRef.current) return
      const newContent = replaceRange(oldContent, pending.range, result.replacementText)
      setSelectionEdit({
        ...pending,
        status: 'review',
        replacementText: result.replacementText,
        newContent,
        ...(newContent === oldContent ? { message: '模型返回的内容没有产生变化。' } : {}),
      })
    } catch (error) {
      if (requestId !== selectionEditRequestRef.current) return
      setSelectionEdit({
        ...pending,
        status: 'error',
        message: error instanceof Error ? error.message : '模型修改请求失败',
      })
    }
  }, [content, fileRef, selectionEdit, threadId])
  const acceptSelectionEdit = useCallback(() => {
    if (selectionEdit?.status !== 'review' || selectionEdit.replacementText === undefined) return
    const editor = editorRef.current
    if (!editor || editor.getText() !== selectionEdit.oldContent) {
      setSelectionEdit((current) => current ? {
        ...current,
        message: '文件在提案生成后又发生了变化。为避免覆盖后续编辑，请重新选择并请求修改。',
      } : current)
      return
    }
    editor.applyEdits([{ range: selectionEdit.range, newText: selectionEdit.replacementText }])
    editor.focus({ lineNumber: selectionEdit.range.start.line + 1, character: selectionEdit.range.start.character })
    setSelectionEdit(null)
  }, [selectionEdit])
  const editSelectionManually = useCallback(() => {
    if (!selectionEdit) return
    editorRef.current?.focus({
      lineNumber: selectionEdit.range.start.line + 1,
      character: selectionEdit.range.start.character,
    })
    setSelectionEdit(null)
  }, [selectionEdit])
  const renderCommentEditor = (
    annotation: LineAnnotation<SourceCommentAnnotation> | DiffLineAnnotation<SourceCommentAnnotation>,
  ) => {
    if (annotation.metadata.kind === 'readonly-comment') {
      return (
        <div className="m-2 rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] px-3 py-2 text-xs text-[var(--lume-text-secondary)]">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--lume-text-muted)]">
            {annotation.metadata.comment.intent === 'modify'
              ? annotation.metadata.pending ? '待发送的修改请求' : '已发送的修改请求'
              : annotation.metadata.comment.intent === 'context'
                ? annotation.metadata.pending ? '待发送的代码上下文' : '已发送的代码上下文'
                : annotation.metadata.pending ? '待发送的审阅意见' : '已发送的审阅意见'}
          </div>
          <p className="m-0 whitespace-pre-wrap">{annotation.metadata.comment.body}</p>
        </div>
      )
    }
    if (annotation.metadata.kind === 'selection-edit' && selectionEdit) {
      return (
        <div className="m-2 overflow-hidden rounded-lg border border-[var(--lume-border-strong)] bg-[var(--lume-bg-elevated)] shadow-sm">
          <div className="flex items-center gap-2 border-b border-[var(--lume-border-subtle)] px-3 py-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--lume-text-muted)]">
              {selectionEdit.status === 'review' ? '模型修改建议 · 文件' : '让模型修改选区'}
            </span>
            <Button variant="ghost" size="icon-xs" onClick={() => setSelectionEdit(null)} aria-label="关闭模型修改"><X size={12} /></Button>
          </div>
          {selectionEdit.status === 'draft' || selectionEdit.status === 'error' ? (
            <div className="p-2">
              <Textarea
                value={selectionEdit.instruction}
                onChange={(event) => setSelectionEdit((current) => current ? { ...current, instruction: event.target.value } : current)}
                placeholder="描述希望怎样修改所选内容…"
                className="min-h-16 resize-y text-xs"
                autoFocus
              />
              {selectionEdit.message && (
                <p className="mb-0 mt-2 text-[11px] text-red-700 dark:text-red-300">{selectionEdit.message}</p>
              )}
              <div className="mt-2 flex justify-end gap-1.5">
                <Button variant="ghost" size="xs" onClick={() => setSelectionEdit(null)}>取消</Button>
                <Button size="xs" disabled={!selectionEdit.instruction.trim()} onClick={() => void requestSelectionEdit()}>
                  生成修改
                </Button>
              </div>
            </div>
          ) : selectionEdit.status === 'pending' ? (
            <div className="flex items-center gap-2 px-3 py-4 text-xs text-[var(--lume-text-muted)]">
              <LoaderCircle size={13} className="animate-spin" />
              模型正在重写所选内容…
            </div>
          ) : selectionEdit.newContent !== undefined ? (
            <>
            <PierreDiffView
              filePath={filePath}
              oldContent={selectionEdit.oldContent}
              newContent={selectionEdit.newContent}
              cacheKey={`selection-edit:${selectionEdit.oldContent.length}:${selectionEdit.newContent.length}`}
              compact
              disableHeader
              expandUnchanged
              virtualizer="parent"
            />
              {selectionEdit.message && (
                <div className="border-t border-amber-500/20 bg-amber-500/8 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                  {selectionEdit.message}
                </div>
              )}
              <div className="flex justify-end gap-1.5 border-t border-[var(--lume-border-subtle)] px-2 py-2">
                <Button variant="ghost" size="xs" onClick={editSelectionManually}>
                  <Pencil size={12} />
                  编辑
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setSelectionEdit(null)}>
                  <X size={12} />
                  拒绝
                </Button>
                <Button size="xs" disabled={selectionEdit.newContent === selectionEdit.oldContent} onClick={acceptSelectionEdit}>
                  <Check size={12} />
                  接受
                </Button>
              </div>
            </>
          ) : null}
        </div>
      )
    }
    return (
      <div className="m-2 rounded-lg border border-[var(--lume-border-strong)] bg-[var(--lume-bg-elevated)] p-2 shadow-sm">
        <Textarea
          value={commentText}
          onChange={(event) => setCommentText(event.target.value)}
          placeholder="留下审阅意见…"
          className="min-h-16 resize-y text-xs"
          autoFocus
        />
        <div className="mt-2 flex justify-end gap-1.5">
          <Button variant="ghost" size="xs" onClick={addSelectionToComposer}>添加到聊天</Button>
          {editable && fileRef && (
            <Button variant="ghost" size="xs" onClick={openLineSelectionEdit}>让模型修改</Button>
          )}
          <Button variant="ghost" size="xs" onClick={closeComment}>取消</Button>
          <Button size="xs" disabled={!commentText.trim()} onClick={saveComment}>添加意见</Button>
        </div>
      </div>
    )
  }

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
          wrapLines={wrapLines}
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
      editable && onContentChange && editorCacheKey ? (
        <PierreEditableFileView<SourceCommentAnnotation>
          content={content}
          filePath={filePath}
          cacheKey={editorCacheKey}
          selectedLines={selectedLines}
          lineAnnotations={lineAnnotations}
          onLineSelected={openComment}
          onGutterUtilityClick={threadId ? openComment : undefined}
          onContentChange={onContentChange}
          wrapLines={wrapLines}
          onEditorAttach={(editor) => {
            editorRef.current = editor
            onEditorAttach?.(editor)
          }}
          renderSelectionAction={renderSelectionAction}
          onPostRender={handlePostRender as never}
          renderAnnotation={renderCommentEditor}
          unsafeCSS={sourceCss}
        />
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
          wrapLines={wrapLines}
          unsafeCSS={sourceCss}
        />
      )
      )}
    </div>
  )
}

const BLAME_CSS = `
  [data-file-selection-action] {
    padding: .25rem .5rem;
    border: 1px solid var(--lume-border-strong);
    border-radius: .375rem;
    background: var(--lume-bg-elevated);
    color: var(--lume-text-primary);
    cursor: pointer;
    font: inherit;
    box-shadow: 0 2px 8px rgb(0 0 0 / .14);
  }
  [data-file-selection-action]:hover {
    background: color-mix(in oklab, var(--lume-bg-elevated) 90%, var(--lume-text-primary));
  }
  [data-file][data-file-blame-visible] [data-column-number] {
    display: grid;
    grid-template-columns: minmax(3ch, auto) 10ch;
    column-gap: .65rem;
    align-items: center;
  }
  [data-file-blame-gutter] {
    position: relative;
    min-width: 0;
    max-width: 10ch;
    color: var(--lume-text-muted);
    font-family: var(--diffs-font-family);
    font-size: inherit;
  }
  [data-file-blame-trigger] {
    display: block;
    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
  }
  [data-file-blame-tooltip] {
    position: absolute;
    z-index: 40;
    top: calc(100% + .35rem);
    left: 0;
    display: none;
    width: 19rem;
    padding: .65rem;
    border: 1px solid var(--lume-border-strong);
    border-radius: .5rem;
    background: var(--lume-bg-elevated);
    color: var(--lume-text-secondary);
    box-shadow: 0 12px 32px rgb(0 0 0 / .22);
    white-space: normal;
  }
  [data-file-blame-gutter]:hover [data-file-blame-tooltip],
  [data-file-blame-gutter]:focus-within [data-file-blame-tooltip],
  [data-file-blame-gutter][data-file-blame-expanded] [data-file-blame-tooltip] {
    display: block;
  }
  [data-file-blame-title] {
    margin-bottom: .5rem;
    color: var(--lume-text-primary);
    font-weight: 600;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  [data-file-blame-meta] {
    display: grid;
    grid-template-columns: 3.5rem minmax(0, 1fr);
    gap: .3rem .5rem;
  }
  [data-file-blame-label] { color: var(--lume-text-muted); }
  [data-file-blame-value] {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-file-blame-actions] {
    display: flex;
    justify-content: flex-end;
    gap: .35rem;
    margin-top: .55rem;
  }
  [data-file-blame-action] {
    padding: .2rem .4rem;
    border: 0;
    border-radius: .3rem;
    background: transparent;
    color: var(--lume-text-secondary);
    cursor: pointer;
    font: inherit;
  }
  [data-file-blame-action]:hover {
    background: color-mix(in oklab, var(--lume-bg-elevated) 90%, var(--lume-text-primary));
    color: var(--lume-text-primary);
  }
`

const blameRoots = new Map<HTMLElement, Root>()

function renderBlameGutters(
  host: HTMLElement,
  lines: CodingBlameLine[],
  expandedLine: number | null,
  onToggle: (lineNumber: number) => void,
) {
  const container = host.shadowRoot ?? host
  const file = container.querySelector<HTMLElement>('[data-file]')
  const activeGutters = new Set<HTMLElement>()
  if (file && lines.length > 0) {
    file.setAttribute('data-file-blame-visible', '')
    const byLine = new Map(lines.map((line) => [line.lineNumber, line]))
    for (const column of file.querySelectorAll<HTMLElement>('[data-column-number]')) {
      const lineNumber = getColumnLineNumber(column)
      const line = lineNumber === null ? undefined : byLine.get(lineNumber)
      let gutter = column.querySelector<HTMLElement>(':scope > [data-file-blame-gutter]')
      if (!line) {
        if (gutter) removeBlameGutter(gutter)
        continue
      }
      if (!gutter) {
        gutter = document.createElement('span')
        gutter.setAttribute('data-file-blame-gutter', '')
        column.append(gutter)
      }
      if (expandedLine === line.lineNumber) gutter.setAttribute('data-file-blame-expanded', '')
      else gutter.removeAttribute('data-file-blame-expanded')
      activeGutters.add(gutter)
      let root = blameRoots.get(gutter)
      if (!root) {
        root = createRoot(gutter)
        blameRoots.set(gutter, root)
      }
      root.render(<BlameGutter line={line} onToggle={onToggle} />)
    }
  } else {
    file?.removeAttribute('data-file-blame-visible')
  }
  for (const gutter of [...blameRoots.keys()]) {
    if (!gutter.isConnected || (container.contains(gutter) && !activeGutters.has(gutter))) {
      removeBlameGutter(gutter)
    }
  }
}

function BlameGutter({ line, onToggle }: { line: CodingBlameLine; onToggle: (lineNumber: number) => void }) {
  const title = line.committed ? line.summary || line.commit.slice(0, 8) : '未提交'
  const pullRequest = inferPullRequest(line)
  return (
    <>
      <button
        type="button"
        data-file-blame-trigger
        title={line.committed ? line.author : '未提交'}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onToggle(line.lineNumber)
        }}
      >
        {line.committed ? line.author : '未提交'}
      </button>
      <span data-file-blame-tooltip role="tooltip" onPointerDown={(event) => event.stopPropagation()}>
        <span data-file-blame-title>{title}</span>
        <span data-file-blame-meta>
          <span data-file-blame-label>作者</span>
          <span data-file-blame-value>{line.committed ? line.author : '未提交'}</span>
          {line.authorTime && (
            <>
              <span data-file-blame-label>日期</span>
              <span data-file-blame-value>{formatBlameDate(line.authorTime)}</span>
            </>
          )}
          <span data-file-blame-label>提交</span>
          <span data-file-blame-value>{line.committed ? line.commit.slice(0, 8) : '工作区'}</span>
          {pullRequest && (
            <>
              <span data-file-blame-label>PR</span>
              <span data-file-blame-value>#{pullRequest.number}</span>
            </>
          )}
        </span>
        {line.committed && (
          <span data-file-blame-actions>
            <button type="button" data-file-blame-action onClick={() => void writeClipboardText(line.commit)}>复制提交</button>
            {line.commitUrl && (
              <button type="button" data-file-blame-action onClick={() => void openExternal(line.commitUrl!)}>打开提交</button>
            )}
            {pullRequest && (
              <button type="button" data-file-blame-action onClick={() => void openExternal(pullRequest.url)}>打开 PR</button>
            )}
          </span>
        )}
      </span>
    </>
  )
}

function getColumnLineNumber(column: HTMLElement): number | null {
  const direct = Number(column.getAttribute('data-column-number'))
  if (Number.isInteger(direct) && direct > 0) return direct
  const row = column.closest<HTMLElement>('[data-line]')
  const nested = Number(row?.getAttribute('data-line'))
  return Number.isInteger(nested) && nested > 0 ? nested : null
}

function removeBlameGutter(gutter: HTMLElement) {
  blameRoots.get(gutter)?.unmount()
  blameRoots.delete(gutter)
  gutter.remove()
}

function inferPullRequest(line: CodingBlameLine): { number: string; url: string } | null {
  if (!line.commitUrl || !line.summary) return null
  const match = line.summary.match(/\(#(\d+)\)\s*$/) ?? line.summary.match(/Merge pull request #(\d+)/i)
  const repository = line.commitUrl.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/commit\//)?.[1]
  return match?.[1] && repository ? { number: match[1], url: `${repository}/pull/${match[1]}` } : null
}

function formatBlameDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().slice(0, 10)
}

function lineRangeToEditorRange(content: string, range: SelectedLineRange): Range {
  const lines = content.split(/\r\n|\n|\r/)
  const startLine = Math.max(0, Math.min(lines.length - 1, range.start - 1))
  const endLine = Math.max(startLine, Math.min(lines.length - 1, range.end - 1))
  return {
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: lines[endLine]?.length ?? 0 },
  }
}

function textForRange(content: string, range: Range): string {
  return content.slice(positionToOffset(content, range.start), positionToOffset(content, range.end))
}

function replaceRange(content: string, range: Range, replacementText: string): string {
  const start = positionToOffset(content, range.start)
  const end = positionToOffset(content, range.end)
  return `${content.slice(0, start)}${replacementText}${content.slice(end)}`
}

function positionToOffset(content: string, position: Range['start']): number {
  let offset = 0
  let line = 0
  while (line < position.line && offset < content.length) {
    const next = content.indexOf('\n', offset)
    if (next === -1) return content.length
    offset = next + 1
    line += 1
  }
  const lineFeed = content.indexOf('\n', offset)
  const rawEnd = lineFeed === -1 ? content.length : lineFeed
  const lineEnd = rawEnd > offset && content[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd
  return Math.min(lineEnd, offset + Math.max(0, position.character))
}
