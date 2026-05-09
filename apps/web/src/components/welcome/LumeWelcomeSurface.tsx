import type { Editor } from '@tiptap/react'
import { EditorContent } from '@tiptap/react'
import { ArrowRight, ChevronRight, Code2, FileText, ListChecks, Loader2, Paperclip, Send } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { RecentThreads } from './RecentThreads'
import { LumeComposer } from '@/components/composer/LumeComposer'
import { deriveLumeComposerState } from '@/components/composer/lume-composer-state'
import type {
  WelcomeSurfaceFileItem,
  WelcomeSurfacePanel,
  WelcomeSurfaceViewModel,
  WelcomeSurfaceWorkflowItem,
} from './welcome-surface-view-model'

interface PendingFile {
  filename: string
  sourcePath: string
}

interface LumeWelcomeSurfaceProps {
  model: WelcomeSurfaceViewModel
  workspaceSelector: ReactNode
  modelPicker: ReactNode
  composerModelPicker: ReactNode
  permissionModePicker: ReactNode
  thinkingLevelPicker: ReactNode
  editor: Editor | null
  pendingFiles: PendingFile[]
  sending: boolean
  hasText: boolean
  onSend: () => void
  onAttach: () => void
  onOpenThread: (threadId: string) => void
  onChoosePromptSeed: (promptSeed: string) => void
  onRemovePendingFile: (index: number) => void
}

export function LumeWelcomeSurface({
  model,
  workspaceSelector,
  modelPicker,
  composerModelPicker,
  permissionModePicker,
  thinkingLevelPicker,
  editor,
  pendingFiles,
  sending,
  hasText,
  onSend,
  onAttach,
  onOpenThread,
  onChoosePromptSeed,
  onRemovePendingFile,
}: LumeWelcomeSurfaceProps) {
  const composerState = deriveLumeComposerState({
    hasText,
    mode: sending ? 'busy' : 'idle',
  })
  const interactionLockProps = sending ? ({ inert: '' } as Record<string, string>) : {}
  const recentThreadsPanel = requirePanelById(model.lowerPanels, 'recent-threads')
  const workflowsPanel = requirePanelById(model.lowerPanels, 'recommended-workflows')
  const recentFilesPanel = requirePanelById(model.lowerPanels, 'recent-files')

  return (
    <div
      className="relative flex flex-1 flex-col overflow-hidden"
      style={{
        background:
          'linear-gradient(180deg, color-mix(in oklab, var(--surface-1) 88%, var(--background)) 0%, var(--background) 30%, color-mix(in oklab, var(--surface-2) 54%, var(--background)) 100%)',
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
        style={{
          background:
            'radial-gradient(circle at 50% 0%, color-mix(in oklab, var(--brand) 9%, transparent) 0%, transparent 52%), radial-gradient(circle at 30% 8%, color-mix(in oklab, var(--brand-2) 7%, transparent) 0%, transparent 38%)',
        }}
      />

      <div className="relative flex-1 overflow-y-auto">
        <div className="relative mx-auto flex w-full max-w-[1104px] flex-col px-5 pb-8 pt-7 md:px-7 md:pb-10 lg:px-8">
          <section className="mx-auto flex w-full max-w-[640px] flex-col items-center pt-4 text-center md:pt-7">
            <HeroMark />

            <h1 className="mt-5 text-[28px] font-semibold text-[var(--text-1)] md:text-[32px]">
              {model.hero.title}
            </h1>
            <p className="mt-3 max-w-[480px] text-[14px] leading-6 text-[var(--text-2)]">
              {model.hero.subtitle}
            </p>

            <div
              {...interactionLockProps}
              data-welcome-lock="hero-controls"
              aria-disabled={sending}
              className="mt-5 flex flex-wrap items-center justify-center gap-3"
            >
              {workspaceSelector}
              {modelPicker}
            </div>
          </section>

          <section className="mt-7 grid grid-cols-1 gap-4 lg:grid-cols-[1.04fr_1fr_1fr]">
          {recentThreadsPanel.id === 'recent-threads' && (
            <RecentThreads panel={recentThreadsPanel} onOpen={onOpenThread} />
          )}

          {workflowsPanel.id === 'recommended-workflows' && (
            <PanelFrame title={workflowsPanel.title} subtitle={workflowsPanel.subtitle}>
              <div
                {...interactionLockProps}
                data-welcome-lock="workflow-panel"
                aria-disabled={sending}
                className="flex flex-1 flex-col"
              >
                {workflowsPanel.items.map((item) => (
                  <WorkflowRow
                    key={item.id}
                    item={item}
                    disabled={sending}
                    onChoosePromptSeed={onChoosePromptSeed}
                  />
                ))}
                <button
                  type="button"
                  disabled={sending}
                  className="mx-auto mt-auto inline-flex items-center gap-1 pt-3 text-[12px] font-medium text-[var(--brand)] transition-colors hover:text-[color:color-mix(in_oklab,var(--brand)_72%,black)] disabled:opacity-60"
                >
                  查看全部工作流
                  <ArrowRight size={13} />
                </button>
              </div>
            </PanelFrame>
          )}

          {recentFilesPanel.id === 'recent-files' && (
            <PanelFrame title={recentFilesPanel.title} subtitle={recentFilesPanel.subtitle}>
              <div className="flex flex-1 flex-col gap-2">
                {recentFilesPanel.items.map((item) => (
                  <RecentFileRow key={item.id} item={item} />
                ))}
              </div>
            </PanelFrame>
          )}
        </section>
        </div>
      </div>

      <section className="relative mx-auto w-full max-w-[1104px] shrink-0 px-5 pb-6 pt-0 md:px-7 lg:px-8">
          <div
            {...interactionLockProps}
            data-welcome-lock="composer"
            aria-disabled={sending}
          >
            <LumeComposer
              tone={composerState.tone}
              scale="hero"
              className={cn('w-full overflow-visible', sending && 'opacity-90')}
              shellStyle={{
                borderColor: 'color-mix(in oklab, var(--brand) 24%, var(--border-strong))',
                background: 'color-mix(in oklab, var(--surface-1) 98%, transparent)',
                boxShadow: '0 22px 48px -38px color-mix(in oklab, var(--brand) 42%, transparent)',
              }}
              editorClassName="px-4 pb-2 pt-4"
              footerClassName="px-3 py-1.5"
              editorSlot={
                <EditorContent
                  editor={editor}
                  className="[&_.ProseMirror]:min-h-[64px] [&_.ProseMirror]:text-[14px] [&_.ProseMirror]:leading-6 [&_.ProseMirror]:text-[var(--text-1)] [&_.ProseMirror]:outline-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-[var(--text-3)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]"
                />
              }
              supportingContent={
                pendingFiles.length > 0 ? (
                  <div className="flex flex-wrap gap-2 px-4 pb-3">
                    {pendingFiles.map((file, index) => (
                      <span
                        key={`${file.sourcePath}:${index}`}
                        className="inline-flex items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_60%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_80%,transparent)] px-3 py-1.5 text-[12px] text-[var(--text-2)]"
                      >
                        <span className="max-w-[180px] truncate">{file.filename}</span>
                        <button
                          type="button"
                          disabled={sending}
                          onClick={() => onRemovePendingFile(index)}
                          className="text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null
              }
              leadingTools={
                <>
                  <button
                    type="button"
                    aria-label="添加文件"
                    title="添加文件"
                    onClick={onAttach}
                    disabled={sending}
                    className="inline-flex size-8 items-center justify-center rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_88%,transparent)] text-[var(--text-2)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] hover:text-[var(--text-1)]"
                  >
                    <Paperclip size={15} />
                  </button>
                  <ToolbarChip>@ 文件</ToolbarChip>
                  <ToolbarChip>/Skill</ToolbarChip>
                  <ToolbarChip># MCP</ToolbarChip>
                </>
              }
              trailingTools={
                <>
                  {composerModelPicker}
                  {permissionModePicker}
                  {thinkingLevelPicker}
                  <button
                    type="button"
                    disabled
                    className="inline-flex h-8 items-center gap-2 rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_52%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_88%,transparent)] px-2.5 text-[11.5px] font-medium text-[var(--text-3)]"
                  >
                    ⌘ ↵
                  </button>
                </>
              }
              actionSlot={
                composerState.showBusy ? (
                  <div className="inline-flex size-8 items-center justify-center rounded-lg bg-[linear-gradient(135deg,var(--brand),var(--brand-2))] text-[var(--brand-foreground)]">
                    <Loader2 size={15} className="animate-spin" />
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label="发送"
                    title="发送"
                    onClick={onSend}
                    disabled={!composerState.canSend}
                    className={cn(
                      'inline-flex size-8 items-center justify-center rounded-lg font-medium transition-all',
                      composerState.canSend
                        ? 'bg-[linear-gradient(135deg,var(--brand),var(--brand-2))] text-[var(--brand-foreground)] shadow-[0_16px_30px_-22px_color-mix(in_oklab,var(--brand)_82%,transparent)] hover:translate-y-[-1px]'
                        : 'cursor-not-allowed bg-[color:color-mix(in_oklab,var(--surface-3)_84%,transparent)] text-[var(--text-3)]',
                    )}
                  >
                    <Send size={15} />
                  </button>
                )
              }
            />
          </div>
          <p className="mt-3 text-center text-[12px] text-[var(--text-3)]">
            Lume 可能会犯错，请核查重要信息。
          </p>
        </section>
    </div>
  )
}

function HeroMark() {
  return (
    <div className="relative flex h-12 w-12 items-center justify-center text-[var(--brand)]">
      <span className="absolute h-10 w-[2px] rounded-full bg-current" />
      <span className="absolute h-10 w-[2px] rotate-45 rounded-full bg-current" />
      <span className="absolute h-10 w-[2px] rotate-90 rounded-full bg-current" />
      <span className="absolute h-10 w-[2px] -rotate-45 rounded-full bg-current" />
      <span className="relative h-2 w-2 rounded-full bg-current" />
    </div>
  )
}

function requirePanelById<TPanel extends WelcomeSurfacePanel['id']>(
  panels: WelcomeSurfacePanel[],
  panelId: TPanel,
) {
  const panel = panels.find(
    (panel): panel is Extract<WelcomeSurfacePanel, { id: TPanel }> => panel.id === panelId,
  )

  if (!panel) {
    throw new Error(`Missing welcome surface panel: ${panelId}`)
  }

  return panel
}

function PanelFrame({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <section className="flex h-full min-h-[190px] flex-col rounded-xl border border-[color:color-mix(in_oklab,var(--border-strong)_50%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_95%,transparent)] p-4 shadow-[0_16px_34px_-32px_hsl(var(--shadow-panel)/0.34)]">
      <header className="mb-3">
        <p className="text-[12px] font-semibold text-[var(--text-1)]">
          {title}
        </p>
        <p className="mt-1 text-[12px] leading-5 text-[var(--text-2)]">{subtitle}</p>
      </header>
      {children}
    </section>
  )
}

function WorkflowRow({
  item,
  disabled,
  onChoosePromptSeed,
}: {
  item: WelcomeSurfaceWorkflowItem
  disabled: boolean
  onChoosePromptSeed: (promptSeed: string) => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChoosePromptSeed(item.promptSeed)}
      className="group flex items-center gap-3 border-b border-[color:color-mix(in_oklab,var(--border-strong)_34%,transparent)] py-2.5 text-left transition-colors last:border-b-0 hover:bg-[color:color-mix(in_oklab,var(--surface-2)_55%,transparent)]"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-2))] text-[var(--brand)]">
        <WorkflowGlyph id={item.id} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--text-1)]">{item.title}</div>
        <div className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">{item.description}</div>
      </div>
      <span className="shrink-0 text-[var(--text-2)] transition-transform group-hover:translate-x-0.5">
        <ChevronRight size={15} />
      </span>
    </button>
  )
}

function WorkflowGlyph({ id }: { id: WelcomeSurfaceWorkflowItem['id'] }) {
  if (id === 'deep-interview') {
    return <FileText size={15} strokeWidth={2.2} />
  }

  if (id === 'ralplan') {
    return <ListChecks size={15} strokeWidth={2.2} />
  }

  return <Code2 size={15} strokeWidth={2.2} />
}

function RecentFileRow({ item }: { item: WelcomeSurfaceFileItem }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3.5 py-2.5',
        item.kind === 'file'
          ? 'border-transparent bg-[color:color-mix(in_oklab,var(--surface-2)_76%,transparent)]'
          : 'border-dashed border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_62%,transparent)]',
      )}
    >
      <div className={cn('text-[13px] font-medium', item.kind === 'file' ? 'text-[var(--text-1)]' : 'text-[var(--text-2)]')}>
        {item.title}
      </div>
      <div className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">{item.meta}</div>
    </div>
  )
}

function ToolbarChip({ children }: { children: ReactNode }) {
  return (
    <button
      type="button"
      className="inline-flex h-8 items-center rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_52%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_88%,transparent)] px-2.5 text-[12px] font-medium text-[var(--text-2)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] hover:text-[var(--text-1)]"
    >
      {children}
    </button>
  )
}
