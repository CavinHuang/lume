import type { Editor } from '@tiptap/react'
import { EditorContent } from '@tiptap/react'
import { Loader2, Image, FileText, Plus, Send, Puzzle } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { LumeComposer } from '@/components/composer/LumeComposer'
import { deriveLumeComposerState } from '@/components/composer/lume-composer-state'
import { AgentAttachmentGrid } from '@/components/agent/AgentAttachmentGrid'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, type AgentListPluginsResult, type AgentPluginListItem, type AgentWelcomeSuggestion } from '@lume/shared'
import type { WelcomeSurfaceViewModel } from './welcome-surface-view-model'

type InstalledPluginSummary = Pick<AgentPluginListItem, 'name' | 'version' | 'description' | 'displayName'>

function normalizeListPluginsResult(result: unknown): InstalledPluginSummary[] {
  if (Array.isArray(result)) return result as InstalledPluginSummary[]
  return (result as Partial<AgentListPluginsResult>).plugins ?? []
}

interface PendingFile {
  id: string
  filename: string
  mediaType: string
  size: number
  sourcePath?: string
  previewUrl?: string
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
  onRemovePendingFile: (index: number) => void
  onPluginSelect?: (pluginName: string) => void
  folderBar?: ReactNode
  suggestions?: AgentWelcomeSuggestion[]
  onSuggestionSelect?: (prompt: string) => void
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
  onRemovePendingFile,
  onPluginSelect,
  folderBar,
  suggestions,
  onSuggestionSelect,
}: LumeWelcomeSurfaceProps) {
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
  const [pluginsPopoverOpen, setPluginsPopoverOpen] = useState(false)
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginSummary[]>([])

  const handleOpenPlugins = async () => {
    setAttachMenuOpen(false)
    try {
      const result = await sidecarCall(AGENT_IPC_CHANNELS.LIST_PLUGINS, {})
      setInstalledPlugins(normalizeListPluginsResult(result))
      setPluginsPopoverOpen(true)
    } catch {
      // silent
    }
  }

  const handleSelectPlugin = (pluginName: string) => {
    setPluginsPopoverOpen(false)
    onPluginSelect?.(pluginName)
  }

  const composerState = deriveLumeComposerState({
    hasText,
    mode: sending ? 'busy' : 'idle',
  })
  const interactionLockProps = sending ? ({ inert: '' } as Record<string, string>) : {}

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

      <div className="relative flex flex-1 flex-col items-center justify-center overflow-y-auto">
        <div className="relative mx-auto flex w-full max-w-[1104px] flex-col items-center px-5 py-10 md:px-7 lg:px-8">
          <section className="flex w-full max-w-[840px] flex-col items-center text-center">
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

          <div
            {...interactionLockProps}
            data-welcome-lock="composer"
            aria-disabled={sending}
            className="mt-8 w-full max-w-[840px]"
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
              topContent={
                pendingFiles.length > 0 ? (
                  <div className="px-4 pb-3 pt-4">
                    <AgentAttachmentGrid
                      attachments={pendingFiles}
                      removable
                      removeDisabled={sending}
                      onRemove={(id) => {
                        if (sending) return
                        const index = pendingFiles.findIndex((file) => file.id === id)
                        if (index >= 0) onRemovePendingFile(index)
                      }}
                    />
                  </div>
                ) : null
              }
              leadingTools={
                <>
                  <div className="relative">
                    <button
                      type="button"
                      aria-label="添加"
                      title="添加"
                      onClick={() => setAttachMenuOpen((v) => !v)}
                      disabled={sending}
                      className="inline-flex size-8 items-center justify-center rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_88%,transparent)] text-[var(--text-2)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] hover:text-[var(--text-1)]"
                    >
                      <Plus size={15} />
                    </button>
                    {attachMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setAttachMenuOpen(false)} />
                        <div className="absolute bottom-full left-0 z-50 mb-2 w-[140px] overflow-hidden rounded-[10px] border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_96%,transparent)] shadow-[0_8px_30px_rgba(28,32,58,0.16)]">
                          <button
                            type="button"
                            onClick={() => { setAttachMenuOpen(false); onAttach() }}
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_60%,transparent)]"
                          >
                            <FileText size={15} className="text-[var(--text-3)]" />
                            文件
                          </button>
                          <button
                            type="button"
                            onClick={() => { setAttachMenuOpen(false); onAttach() }}
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_60%,transparent)]"
                          >
                            <Image size={15} className="text-[var(--text-3)]" />
                            图片
                          </button>
                          <button
                            type="button"
                            onClick={handleOpenPlugins}
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_60%,transparent)]"
                          >
                            <Puzzle size={15} className="text-[var(--text-3)]" />
                            插件
                          </button>
                        </div>
                      </>
                    )}
                    {pluginsPopoverOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setPluginsPopoverOpen(false)} />
                        <div className="absolute bottom-full left-0 z-50 mb-2 w-[260px] overflow-hidden rounded-[10px] border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_96%,transparent)] shadow-[0_8px_30px_rgba(28,32,58,0.16)]">
                          <div className="px-3 py-2 text-[11px] font-medium text-[var(--text-3)]">
                            已安装插件
                          </div>
                          {installedPlugins.length === 0 ? (
                            <div className="px-3 py-3 text-[13px] text-[var(--text-3)]">
                              暂无已安装的插件
                            </div>
                          ) : (
                            <div className="max-h-[200px] overflow-y-auto">
                              {installedPlugins.map((plugin) => (
                                <button
                                  key={plugin.name}
                                  type="button"
                                  onClick={() => handleSelectPlugin(plugin.name)}
                                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_60%,transparent)]"
                                >
                                  <Puzzle size={14} className="shrink-0 text-[var(--text-3)]" />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13px] text-[var(--text-1)]">
                                      {plugin.name}
                                    </div>
                                    <div className="truncate text-[11px] text-[var(--text-3)]">
                                      v{plugin.version}
                                      {plugin.description ? ` · ${plugin.description}` : ''}
                                    </div>
                                  </div>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </>
              }
              trailingTools={
                <>
                  {composerModelPicker}
                  {permissionModePicker}
                  {thinkingLevelPicker}
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
          {folderBar && (
            <div
              className="mt-[-12px] w-full max-w-[840px] rounded-b-[1rem] border border-t-0 border-[color:color-mix(in_oklab,var(--border-strong)_42%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_58%,var(--surface-1))] px-3 pt-6 pb-2"
            >
              {folderBar}
            </div>
          )}
          {suggestions && suggestions.length > 0 && (
            <div className="mt-4 flex w-full max-w-[840px] flex-wrap justify-center gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  title={suggestion.prompt}
                  onClick={() => onSuggestionSelect?.(suggestion.prompt)}
                  disabled={sending}
                  className="inline-flex max-w-full items-center rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_46%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_82%,transparent)] px-3 py-1.5 text-[13px] text-[var(--text-2)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_20%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-1)_96%,transparent)] hover:text-[var(--text-1)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="truncate">{suggestion.title}</span>
                </button>
              ))}
            </div>
          )}
          <p className="mt-3 text-center text-[12px] text-[var(--text-3)]">
            Lume 可能会犯错，请核查重要信息。
          </p>
        </div>
      </div>
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
