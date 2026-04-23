import type { Editor } from '@tiptap/react'
import { EditorContent } from '@tiptap/react'
import { ArrowUpRight, Loader2, Paperclip, Send } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { RecentThreads } from './RecentThreads'
import { getLumeComposerPrimaryActionClassName, LumeComposer } from '@/components/composer/LumeComposer'
import { deriveLumeComposerState } from '@/components/composer/lume-composer-state'
import type {
  WelcomeSurfaceFileItem,
  WelcomeSurfacePanel,
  WelcomeSurfacePrimaryCard,
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
      className="relative flex-1 overflow-y-auto"
      style={{
        background:
          'linear-gradient(180deg, color-mix(in oklab, var(--surface-1) 86%, var(--background)) 0%, var(--background) 24%, color-mix(in oklab, var(--surface-2) 68%, var(--background)) 100%)',
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
        style={{
          background:
            'radial-gradient(circle at 50% 0%, color-mix(in oklab, var(--brand) 17%, transparent) 0%, transparent 54%), radial-gradient(circle at 20% 10%, color-mix(in oklab, var(--brand-2) 12%, transparent) 0%, transparent 42%)',
        }}
      />

      <div className="relative mx-auto flex min-h-full w-full max-w-[1200px] flex-col px-6 pb-10 pt-10 md:px-10 md:pb-14 lg:px-14">
        <section className="mx-auto flex w-full max-w-[780px] flex-col items-center pt-10 text-center md:pt-16">
          <HeroMark />

          <h1 className="mt-7 text-[34px] font-semibold tracking-[-0.03em] text-[var(--text-1)] md:text-[46px]">
            {model.hero.title}
          </h1>
          <p className="mt-4 max-w-[560px] text-[15px] leading-7 text-[var(--text-2)] md:text-[16px]">
            {model.hero.subtitle}
          </p>

          <div
            {...interactionLockProps}
            data-welcome-lock="hero-controls"
            aria-disabled={sending}
            className="mt-8 flex flex-wrap items-center justify-center gap-3"
          >
            {workspaceSelector}
            {modelPicker}
          </div>
        </section>

        <section
          {...interactionLockProps}
          data-welcome-lock="primary-cards"
          aria-disabled={sending}
          className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4"
        >
          {model.primaryCards.map((card) => (
            <PrimaryCard
              key={card.id}
              card={card}
              disabled={sending}
              onChoosePromptSeed={onChoosePromptSeed}
            />
          ))}
        </section>

        <section className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[1.15fr_1fr_1fr]">
          {recentThreadsPanel.id === 'recent-threads' && (
            <RecentThreads panel={recentThreadsPanel} onOpen={onOpenThread} />
          )}

          {workflowsPanel.id === 'recommended-workflows' && (
            <PanelFrame title={workflowsPanel.title} subtitle={workflowsPanel.subtitle}>
              <div
                {...interactionLockProps}
                data-welcome-lock="workflow-panel"
                aria-disabled={sending}
                className="flex flex-1 flex-col gap-2"
              >
                {workflowsPanel.items.map((item) => (
                  <WorkflowRow
                    key={item.id}
                    item={item}
                    disabled={sending}
                    onChoosePromptSeed={onChoosePromptSeed}
                  />
                ))}
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

        <section className="mx-auto mt-7 w-full max-w-[920px]">
          <div className="rounded-[2rem] border border-[color:color-mix(in_oklab,var(--border-strong)_58%,transparent)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--surface-1)_95%,transparent),color-mix(in_oklab,var(--surface-2)_88%,transparent))] px-5 py-5 shadow-[0_28px_56px_-44px_hsl(var(--shadow-panel)/0.42)] backdrop-blur">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-3)]">
                  直接开始
                </p>
                <p className="mt-1 text-[13px] leading-6 text-[var(--text-2)]">
                  从这里继续当前工作流，发送后会创建一条新会话。
                </p>
              </div>
            </div>

            <div
              {...interactionLockProps}
              data-welcome-lock="composer"
              aria-disabled={sending}
            >
              <LumeComposer
                tone={composerState.tone}
                scale="hero"
                className={cn('mt-4', sending && 'opacity-90')}
                editorSlot={
                  <EditorContent
                    editor={editor}
                    className="[&_.ProseMirror]:min-h-[110px] [&_.ProseMirror]:text-[15px] [&_.ProseMirror]:leading-7 [&_.ProseMirror]:text-[var(--text-1)] [&_.ProseMirror]:outline-none"
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
                      onClick={onAttach}
                      disabled={sending}
                      className="inline-flex h-10 items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_72%,transparent)] px-4 text-[13px] font-medium text-[var(--text-2)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] hover:text-[var(--text-1)]"
                    >
                      <Paperclip size={14} />
                      添加文件
                    </button>
                    {thinkingLevelPicker}
                  </>
                }
                actionSlot={
                  composerState.showBusy ? (
                    <div className="inline-flex h-11 items-center gap-2 rounded-full bg-[linear-gradient(135deg,var(--brand),var(--brand-2))] px-5 text-[13px] font-medium text-[var(--brand-foreground)]">
                      <Loader2 size={15} className="animate-spin" />
                      正在发送
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={onSend}
                      disabled={!composerState.canSend}
                      className={getLumeComposerPrimaryActionClassName({
                        enabled: composerState.canSend,
                        size: 'hero',
                      })}
                    >
                      发送
                      <Send size={14} />
                    </button>
                  )
                }
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function HeroMark() {
  return (
    <div className="relative flex h-24 w-24 items-center justify-center">
      <div className="absolute inset-0 rounded-[2rem] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--brand)_88%,white),color-mix(in_oklab,var(--brand-2)_82%,white))] shadow-[0_26px_48px_-30px_color-mix(in_oklab,var(--brand)_65%,transparent)]" />
      <div className="absolute inset-[12px] rounded-[1.3rem] border border-white/28 bg-[linear-gradient(180deg,rgba(255,255,255,0.26),rgba(255,255,255,0.08))]" />
      <div className="relative flex h-10 w-10 items-center justify-center rounded-[0.95rem] bg-white/92 text-[15px] font-semibold tracking-[0.08em] text-[color:color-mix(in_oklab,var(--brand)_72%,black)]">
        L
      </div>
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

function PrimaryCard({
  card,
  disabled,
  onChoosePromptSeed,
}: {
  card: WelcomeSurfacePrimaryCard
  disabled: boolean
  onChoosePromptSeed: (promptSeed: string) => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChoosePromptSeed(card.promptSeed)}
      className="group flex min-h-[188px] flex-col rounded-[1.85rem] border border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--surface-1)_95%,transparent),color-mix(in_oklab,var(--surface-2)_82%,transparent))] p-5 text-left shadow-[0_20px_38px_-36px_hsl(var(--shadow-panel)/0.34)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] hover:bg-[linear-gradient(180deg,color-mix(in_oklab,var(--surface-1)_98%,transparent),color-mix(in_oklab,var(--surface-3)_78%,transparent))]"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_82%,transparent)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-3)]">
          {card.eyebrow}
        </div>
        <div className="flex h-11 w-11 items-center justify-center rounded-[1rem] bg-[color:color-mix(in_oklab,var(--brand)_12%,var(--surface-2))]">
          <CardGlyph id={card.id} />
        </div>
      </div>

      <div className="mt-8 flex-1">
        <h2 className="text-[18px] font-semibold leading-7 text-[var(--text-1)]">{card.title}</h2>
        <p className="mt-3 text-[14px] leading-7 text-[var(--text-2)]">{card.description}</p>
      </div>

      <div className="mt-5 flex items-center justify-between text-[13px] text-[var(--text-3)]">
        <span>填入起始提示</span>
        <ArrowUpRight size={15} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </div>
    </button>
  )
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
    <section className="flex h-full flex-col rounded-[1.7rem] border border-[color:color-mix(in_oklab,var(--border-strong)_52%,transparent)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--surface-1)_94%,transparent),color-mix(in_oklab,var(--surface-2)_84%,transparent))] p-5 shadow-[0_20px_44px_-38px_hsl(var(--shadow-panel)/0.35)]">
      <header className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--text-3)]">
          {title}
        </p>
        <p className="mt-1 text-[13px] leading-6 text-[var(--text-2)]">{subtitle}</p>
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
      className="group flex rounded-[1.15rem] border border-transparent bg-[color:color-mix(in_oklab,var(--surface-2)_76%,transparent)] px-3.5 py-3 text-left transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-3)_72%,transparent)]"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--text-1)]">{item.title}</div>
        <div className="mt-1 text-[12px] leading-6 text-[var(--text-3)]">{item.description}</div>
      </div>
      <span className="ml-3 text-[12px] text-[var(--text-3)] transition-transform group-hover:translate-x-0.5">
        使用
      </span>
    </button>
  )
}

function RecentFileRow({ item }: { item: WelcomeSurfaceFileItem }) {
  return (
    <div
      className={cn(
        'rounded-[1.15rem] border px-3.5 py-3',
        item.kind === 'file'
          ? 'border-transparent bg-[color:color-mix(in_oklab,var(--surface-2)_76%,transparent)]'
          : 'border-dashed border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_62%,transparent)]',
      )}
    >
      <div className={cn('text-[13px] font-medium', item.kind === 'file' ? 'text-[var(--text-1)]' : 'text-[var(--text-2)]')}>
        {item.title}
      </div>
      <div className="mt-1 text-[12px] leading-6 text-[var(--text-3)]">{item.meta}</div>
    </div>
  )
}

function CardGlyph({ id }: { id: WelcomeSurfacePrimaryCard['id'] }) {
  if (id === 'plan') {
    return (
      <div className="relative h-5 w-5">
        <span className="absolute left-0 top-1 h-3 w-3 rounded-md border border-[color:color-mix(in_oklab,var(--brand)_50%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_18%,white)]" />
        <span className="absolute right-0 top-0 h-3.5 w-3.5 rounded-full bg-[color:color-mix(in_oklab,var(--brand-2)_58%,white)]" />
      </div>
    )
  }

  if (id === 'ship') {
    return (
      <div className="relative h-5 w-5">
        <span className="absolute inset-x-1 bottom-0 top-2 rounded-full bg-[color:color-mix(in_oklab,var(--brand)_68%,white)]" />
        <span className="absolute left-2 top-0 h-3.5 w-1 rounded-full bg-[color:color-mix(in_oklab,var(--brand-2)_72%,white)]" />
      </div>
    )
  }

  if (id === 'analyze') {
    return (
      <div className="grid h-5 w-5 grid-cols-2 gap-1">
        <span className="rounded-sm bg-[color:color-mix(in_oklab,var(--brand)_58%,white)]" />
        <span className="rounded-sm bg-[color:color-mix(in_oklab,var(--brand-2)_48%,white)]" />
        <span className="rounded-sm bg-[color:color-mix(in_oklab,var(--brand-2)_72%,white)]" />
        <span className="rounded-sm bg-[color:color-mix(in_oklab,var(--brand)_24%,white)]" />
      </div>
    )
  }

  return (
    <div className="relative flex h-5 w-5 items-center justify-center">
      <span className="absolute h-5 w-5 rounded-full border border-[color:color-mix(in_oklab,var(--brand)_44%,transparent)]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[color:color-mix(in_oklab,var(--brand)_70%,white)]" />
    </div>
  )
}
