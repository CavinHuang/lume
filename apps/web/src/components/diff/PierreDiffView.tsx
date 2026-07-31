import { Component, useMemo, type ErrorInfo, type ReactNode } from 'react'
import { useCodeTheme } from '@lume/ui'
import {
  parseDiffFromFile,
  parsePatchFiles,
  type DiffLineAnnotation,
  type FileContents,
  type FileDiffMetadata,
  type LineAnnotation,
  type LineDiffTypes,
  type SelectedLineRange,
} from '@pierre/diffs'
import { File, FileDiff, Virtualizer } from '@pierre/diffs/react'
import type { Editor, EditorOptions } from '@pierre/diffs/edit'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LUME_DIFF_CSS, LUME_DIFF_THEMES } from './pierre-theme'
import { normalizeDiffSnippet } from './diff-normalize'

export interface PierreDiffViewProps<TAnnotation = unknown> {
  patch?: string
  oldContent?: string
  newContent?: string
  filePath?: string
  cacheKey?: string
  viewMode?: 'unified' | 'split'
  wrapLines?: boolean
  ignoreWhitespace?: boolean
  lineDiffType?: LineDiffTypes
  expandUnchanged?: boolean
  collapsedContextThreshold?: number
  expansionLineCount?: number
  compact?: boolean
  className?: string
  selectedLines?: SelectedLineRange | null
  lineAnnotations?: DiffLineAnnotation<TAnnotation>[]
  enableLineSelection?: boolean
  enableGutterUtility?: boolean
  onLineSelected?: (range: SelectedLineRange | null) => void
  onLineSelectionChange?: (range: SelectedLineRange | null) => void
  onGutterUtilityClick?: (range: SelectedLineRange) => void
  renderAnnotation?: (annotation: DiffLineAnnotation<TAnnotation>) => ReactNode
  renderHeaderMetadata?: Parameters<typeof FileDiff<TAnnotation>>[0]['renderHeaderMetadata']
  unsafeCSS?: string
  disableHeader?: boolean
  virtualizer?: 'self' | 'parent'
}

export function createPierreFileDiff(input: Pick<PierreDiffViewProps, 'patch' | 'oldContent' | 'newContent' | 'filePath' | 'cacheKey' | 'ignoreWhitespace'>): FileDiffMetadata[] {
  const filePath = input.filePath || 'snippet.diff'
  if (input.patch) {
    const patch = normalizeDiffSnippet(input.patch, filePath)
    return parsePatchFiles(patch, input.cacheKey, true).flatMap((parsed) => parsed.files)
  }
  const oldFile: FileContents = {
    name: filePath,
    contents: input.oldContent ?? '',
    cacheKey: input.cacheKey ? `${input.cacheKey}:old` : undefined,
  }
  const newFile: FileContents = {
    name: filePath,
    contents: input.newContent ?? '',
    cacheKey: input.cacheKey ? `${input.cacheKey}:new` : undefined,
  }
  return [parseDiffFromFile(
    oldFile,
    newFile,
    input.ignoreWhitespace ? { ignoreWhitespace: true } : undefined,
    true,
  )]
}

export function PierreDiffView<TAnnotation = unknown>({
  patch,
  oldContent,
  newContent,
  filePath,
  cacheKey,
  viewMode = 'unified',
  wrapLines = false,
  ignoreWhitespace = false,
  lineDiffType = 'word',
  expandUnchanged = false,
  collapsedContextThreshold,
  expansionLineCount = 100,
  compact = false,
  className,
  selectedLines,
  lineAnnotations,
  enableLineSelection = false,
  enableGutterUtility = false,
  onLineSelected,
  onLineSelectionChange,
  onGutterUtilityClick,
  renderAnnotation,
  renderHeaderMetadata,
  unsafeCSS,
  disableHeader = false,
  virtualizer = 'self',
}: PierreDiffViewProps<TAnnotation>) {
  const theme = useCodeTheme()
  const effectiveCacheKey = cacheKey ? `${cacheKey}:${ignoreWhitespace ? 'ignore-whitespace' : 'all'}` : undefined
  const files = useMemo(
    () => createPierreFileDiff({ patch, oldContent, newContent, filePath, cacheKey: effectiveCacheKey, ignoreWhitespace }),
    [effectiveCacheKey, filePath, ignoreWhitespace, newContent, oldContent, patch],
  )
  const options = useMemo(() => ({
    theme: LUME_DIFF_THEMES,
    themeType: theme.type,
    diffStyle: viewMode,
    overflow: wrapLines ? 'wrap' as const : 'scroll' as const,
    expandUnchanged: compact ? false : expandUnchanged,
    collapsedContextThreshold: collapsedContextThreshold ?? (compact ? 6 : 1),
    expansionLineCount,
    lineDiffType,
    disableFileHeader: disableHeader,
    enableLineSelection,
    controlledSelection: enableLineSelection,
    enableGutterUtility,
    onLineSelected,
    onLineSelectionChange,
    unsafeCSS: `${LUME_DIFF_CSS}\n${unsafeCSS ?? ''}`,
  }), [
    compact,
    collapsedContextThreshold,
    disableHeader,
    enableGutterUtility,
    enableLineSelection,
    expandUnchanged,
    expansionLineCount,
    lineDiffType,
    onLineSelected,
    onLineSelectionChange,
    theme.type,
    unsafeCSS,
    viewMode,
    wrapLines,
  ])

  if (files.length === 0) {
    return <div className="px-3 py-4 text-xs text-[var(--lume-text-muted)]">没有可显示的文件变更</div>
  }

  const renderedFiles = files.map((file, index) => (
    <FileDiff<TAnnotation>
      key={`${file.name}:${file.cacheKey ?? index}`}
      fileDiff={file}
      options={{
        ...options,
        hunkSeparators: file.additionLines.length > 0 ? 'line-info' : 'metadata',
      }}
      selectedLines={files.length === 1 ? selectedLines : undefined}
      lineAnnotations={files.length === 1 ? lineAnnotations : undefined}
      renderAnnotation={renderAnnotation}
      renderGutterUtility={onGutterUtilityClick
        ? (getHoveredLine) => (
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded bg-[var(--lume-text-primary)] text-[var(--lume-bg-panel)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--lume-text-primary)_88%,var(--lume-bg-panel))]"
              title="请求更改"
              aria-label="为当前行请求更改"
              onClick={() => {
                const hoveredLine = getHoveredLine()
                if (!hoveredLine) return
                onGutterUtilityClick({
                  start: hoveredLine.lineNumber,
                  end: hoveredLine.lineNumber,
                  side: hoveredLine.side,
                  endSide: hoveredLine.side,
                })
              }}
            >
              <Plus className="size-3.5" strokeWidth={2.25} />
            </button>
          )
        : undefined}
      renderHeaderMetadata={renderHeaderMetadata}
    />
  ))

  return (
    <PierreRenderErrorBoundary resetKey={`${theme.type}:${effectiveCacheKey ?? patch ?? `${filePath}:${oldContent}:${newContent}`}`}>
      {virtualizer === 'parent'
        ? <div className={cn('min-w-0', className)}>{renderedFiles}</div>
        : (
            <Virtualizer
              className={cn('min-h-0 max-h-[70vh] overflow-auto', className)}
              config={{ overscrollSize: 500 }}
            >
              {renderedFiles}
            </Virtualizer>
          )}
    </PierreRenderErrorBoundary>
  )
}

export function PierreFileView<TAnnotation = unknown>({
  content,
  filePath,
  selectedLines,
  lineAnnotations,
  enableLineSelection = true,
  enableGutterUtility = false,
  onLineSelected,
  onGutterUtilityClick,
  onLineNumberClick,
  onPostRender,
  renderAnnotation,
  unsafeCSS,
}: {
  content: string
  filePath: string
  selectedLines?: SelectedLineRange | null
  lineAnnotations?: LineAnnotation<TAnnotation>[]
  enableLineSelection?: boolean
  enableGutterUtility?: boolean
  onLineSelected?: (range: SelectedLineRange | null) => void
  onGutterUtilityClick?: (range: SelectedLineRange) => void
  onLineNumberClick?: NonNullable<Parameters<typeof File>[0]['options']>['onLineNumberClick']
  onPostRender?: NonNullable<Parameters<typeof File>[0]['options']>['onPostRender']
  renderAnnotation?: (annotation: LineAnnotation<TAnnotation>) => ReactNode
  unsafeCSS?: string
}) {
  const theme = useCodeTheme()
  return (
    <PierreRenderErrorBoundary resetKey={`${theme.type}:${filePath}:${content}`}>
      <Virtualizer className="min-h-full min-w-full overflow-auto" config={{ overscrollSize: 500 }}>
        <File<TAnnotation>
          file={{ name: filePath, contents: content, cacheKey: `${filePath}:${content.length}` }}
          selectedLines={selectedLines}
          lineAnnotations={lineAnnotations}
          options={{
            theme: LUME_DIFF_THEMES,
            themeType: theme.type,
            overflow: 'scroll',
            disableFileHeader: true,
            enableLineSelection,
            controlledSelection: enableLineSelection,
            enableGutterUtility,
            onLineSelected,
            onLineNumberClick,
            onPostRender,
            unsafeCSS: `${LUME_DIFF_CSS}\n${unsafeCSS ?? ''}`,
          }}
          renderAnnotation={renderAnnotation}
          renderGutterUtility={onGutterUtilityClick
            ? (getHoveredLine) => (
                <button
                  type="button"
                  className="flex size-5 items-center justify-center rounded text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
                  title="请求更改"
                  aria-label="为当前行请求更改"
                  onClick={() => {
                    const hoveredLine = getHoveredLine()
                    if (!hoveredLine) return
                    onGutterUtilityClick({
                      start: hoveredLine.lineNumber,
                      end: hoveredLine.lineNumber,
                    })
                  }}
                >
                  <Plus className="size-3.5" strokeWidth={2.25} />
                </button>
              )
            : undefined}
          className="min-h-full min-w-full"
        />
      </Virtualizer>
    </PierreRenderErrorBoundary>
  )
}

export function PierreEditableFileView<TAnnotation = unknown>({
  content,
  filePath,
  cacheKey,
  selectedLines,
  lineAnnotations,
  onLineSelected,
  onContentChange,
  onEditorAttach,
  renderSelectionAction,
  onPostRender,
  renderAnnotation,
  onGutterUtilityClick,
  onLineNumberClick,
  unsafeCSS,
}: {
  content: string
  filePath: string
  cacheKey: string
  selectedLines?: SelectedLineRange | null
  lineAnnotations?: LineAnnotation<TAnnotation>[]
  onLineSelected?: (range: SelectedLineRange | null) => void
  onContentChange: (content: string) => void
  onEditorAttach?: (editor: Editor<TAnnotation>) => void
  renderSelectionAction?: NonNullable<EditorOptions<TAnnotation>['renderSelectionAction']>
  onPostRender?: NonNullable<Parameters<typeof File>[0]['options']>['onPostRender']
  renderAnnotation?: (annotation: LineAnnotation<TAnnotation>) => ReactNode
  onGutterUtilityClick?: (range: SelectedLineRange) => void
  onLineNumberClick?: NonNullable<Parameters<typeof File>[0]['options']>['onLineNumberClick']
  unsafeCSS?: string
}) {
  const theme = useCodeTheme()
  const editorOptions = useMemo<EditorOptions<TAnnotation>>(() => ({
    persistState: true,
    enabledSelectionAction: Boolean(renderSelectionAction),
    renderSelectionAction,
    onAttach: (editor) => onEditorAttach?.(editor),
    onChange: (file) => onContentChange(file.contents),
  }), [onContentChange, onEditorAttach, renderSelectionAction])
  return (
    <PierreRenderErrorBoundary resetKey={`${theme.type}:${cacheKey}`}>
      <Virtualizer className="min-h-full min-w-full overflow-auto" config={{ overscrollSize: 500 }}>
        <File<TAnnotation>
          file={{ name: filePath, contents: content, cacheKey }}
          edit
          editorOptions={editorOptions}
          selectedLines={selectedLines}
          lineAnnotations={lineAnnotations}
          options={{
            theme: LUME_DIFF_THEMES,
            themeType: theme.type,
            overflow: 'scroll',
            disableFileHeader: true,
            enableLineSelection: true,
            controlledSelection: true,
            onLineSelected,
            onLineNumberClick,
            onPostRender,
            unsafeCSS: `${LUME_DIFF_CSS}\n${unsafeCSS ?? ''}`,
          }}
          renderAnnotation={renderAnnotation}
          renderGutterUtility={onGutterUtilityClick
            ? (getHoveredLine) => (
                <button
                  type="button"
                  className="flex size-5 items-center justify-center rounded text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]"
                  title="请求更改"
                  aria-label="为当前行请求更改"
                  onClick={() => {
                    const hoveredLine = getHoveredLine()
                    if (!hoveredLine) return
                    onGutterUtilityClick({ start: hoveredLine.lineNumber, end: hoveredLine.lineNumber })
                  }}
                >
                  <Plus className="size-3.5" strokeWidth={2.25} />
                </button>
              )
            : undefined}
          className="min-h-full min-w-full"
        />
      </Virtualizer>
    </PierreRenderErrorBoundary>
  )
}

class PierreRenderErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: string | null }
> {
  state = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Pierre renderer failed', error, info)
  }

  componentDidUpdate(previous: Readonly<{ children: ReactNode; resetKey: string }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="px-3 py-4 text-xs text-[var(--lume-danger)]">
          Diff 渲染失败：{this.state.error}
        </div>
      )
    }
    return this.props.children
  }
}
