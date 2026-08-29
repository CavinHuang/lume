import type { Editor } from '@tiptap/react'
import { EditorContent } from '@tiptap/react'
import { ArrowUp, Loader2, LoaderCircle, FileText, MonitorOff, Plus } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { LumeComposer } from '@/components/composer/LumeComposer'
import { deriveLumeComposerState } from '@/components/composer/lume-composer-state'
import { PendingAttachmentList } from '@/components/agent/PendingAttachmentList'
import { type AgentWelcomeSuggestion, type DesktopContextTarget } from '@lume/shared'
import type { WelcomeSurfaceViewModel } from './welcome-surface-view-model'
import { DesktopContextPlusItem } from '@/components/agent/DesktopContextPlusItem'
import { DesktopContextSelectionChip } from '@/components/agent/DesktopContextSelectionChip'

import { Button } from '@/components/ui/button'
interface PendingFile {
  id: string
  filename: string
  mediaType: string
  size: number
  sourcePath?: string
  previewUrl?: string
}

interface LumeWelcomeSurfaceProps {
  compact?: boolean
  model: WelcomeSurfaceViewModel
  workspaceSelector: ReactNode
  composerModelPicker: ReactNode
  permissionModePicker: ReactNode
  thinkingLevelPicker: ReactNode
  editor: Editor | null
  pendingFiles: PendingFile[]
  sending: boolean
  hasText: boolean
  onSend: () => void
  onAttach: () => void
  onAttachMenuOpen?: () => void | Promise<void>
  onRemovePendingFile: (index: number) => void
  desktopContextTarget?: DesktopContextTarget
  selectedDesktopContextTarget?: DesktopContextTarget
  desktopContextCaptureLoading?: boolean
  desktopContextCaptureMessage?: string
  desktopContextPermissionRequestAvailable?: boolean
  desktopContextPermissionRequestLoading?: boolean
  onSelectDesktopContextTarget?: (target: DesktopContextTarget) => void
  onRequestDesktopContextPermissions?: () => void | Promise<void>
  onClearDesktopContextTarget?: () => void
  folderBar?: ReactNode
  suggestions?: AgentWelcomeSuggestion[]
  onSuggestionSelect?: (prompt: string) => void
}

export function LumeWelcomeSurface({
  compact = false,
  model,
  workspaceSelector,
  composerModelPicker,
  permissionModePicker,
  thinkingLevelPicker,
  editor,
  pendingFiles,
  sending,
  hasText,
  onSend,
  onAttach,
  onAttachMenuOpen,
  onRemovePendingFile,
  desktopContextTarget,
  selectedDesktopContextTarget,
  desktopContextCaptureLoading = false,
  desktopContextCaptureMessage,
  desktopContextPermissionRequestAvailable = false,
  desktopContextPermissionRequestLoading = false,
  onSelectDesktopContextTarget,
  onRequestDesktopContextPermissions,
  onClearDesktopContextTarget,
  folderBar,
  suggestions,
  onSuggestionSelect,
}: LumeWelcomeSurfaceProps) {
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)

  const handleToggleAttachMenu = () => {
    const nextOpen = !attachMenuOpen
    setAttachMenuOpen(nextOpen)
    if (nextOpen) void onAttachMenuOpen?.()
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
        background: 'var(--background)',
      }}
    >
      <div className={cn('relative flex flex-1 flex-col items-center overflow-y-auto', compact ? 'justify-end' : 'justify-center')}>
        <div className={cn('relative mx-auto flex w-full flex-col items-center', compact ? 'max-w-none px-4 py-4' : 'max-w-[1104px] px-5 py-10 md:px-7 lg:px-8')}>
          {!compact && <section className="flex w-full max-w-[840px] flex-col items-center text-center">
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
            </div>
          </section>}

          <div
            {...interactionLockProps}
            data-welcome-lock="composer"
            aria-disabled={sending}
            className={cn('w-full', compact ? 'max-w-none' : 'mt-8 max-w-[840px]')}
          >
            <LumeComposer
              tone={composerState.tone}
              className={cn('w-full overflow-visible', sending && 'opacity-90')}
              editorSlot={
                <EditorContent
                  editor={editor}
                  className="[&_.ProseMirror]:min-h-[64px] [&_.ProseMirror]:text-[14px] [&_.ProseMirror]:leading-6 [&_.ProseMirror]:text-[var(--text-1)] [&_.ProseMirror]:outline-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none [&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left [&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0 [&_.ProseMirror_p.is-editor-empty:first-child::before]:text-[var(--text-3)] [&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]"
                />
              }
              topContent={
                pendingFiles.length > 0 ? (
                  <div className="px-4 pb-3 pt-4">
                    <PendingAttachmentList
                      attachments={pendingFiles}
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
              supportingContent={
                selectedDesktopContextTarget ? (
                  <div className="px-4 pb-2">
                    <DesktopContextSelectionChip
                      target={selectedDesktopContextTarget}
                      onClear={onClearDesktopContextTarget}
                    />
                  </div>
                ) : undefined
              }
              leadingTools={
                <>
                  <div className="relative">
                    <Button
                variant="ghost"
                      type="button"
                      aria-label="添加"
                      title="添加"
                      onClick={handleToggleAttachMenu}
                      disabled={sending}
                      className="inline-flex size-8 items-center justify-center rounded-lg text-[var(--text-2)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-1)]"
                    >
                      <Plus size={15} />
                    </Button>
                    {attachMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setAttachMenuOpen(false)} />
                        <div className="absolute bottom-full left-0 z-50 mb-2 w-[360px] overflow-hidden rounded-[10px] border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_96%,transparent)] shadow-[0_8px_30px_rgba(28,32,58,0.16)]">
                          <Button
                variant="ghost"
                            type="button"
                            onClick={() => { setAttachMenuOpen(false); onAttach() }}
                            className="flex w-full items-center justify-start gap-2.5 px-3 py-2.5 text-left text-[13px] text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_60%,transparent)]"
                          >
                            <FileText size={15} className="text-[var(--text-3)]" />
                            文件
                          </Button>
                          <div className="border-t border-[var(--lume-border-subtle)]" />
                          <div className="px-3 py-2 text-xs font-medium text-[var(--text-3)]">
                            当前应用
                          </div>
                          {desktopContextTarget ? (
                            <DesktopContextPlusItem
                              target={desktopContextTarget}
                              active={false}
                              onActivate={() => {
                                setAttachMenuOpen(false)
                                onSelectDesktopContextTarget?.(desktopContextTarget)
                              }}
                            />
                          ) : (
                            <div className="px-3 pb-3">
                              <div className="rounded-xl border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--surface-2)_72%,transparent)] px-3 py-2.5">
                                <div className="flex items-start gap-2.5">
                                  <div className="mt-0.5 text-[var(--text-3)]">
                                    {desktopContextCaptureLoading
                                      ? <LoaderCircle size={15} className="animate-spin" />
                                      : <MonitorOff size={15} />}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-[var(--text-1)]">
                                      {desktopContextCaptureLoading ? '正在检查当前应用' : '当前应用暂不可用'}
                                    </div>
                                    <div className="mt-0.5 text-xs leading-5 text-[var(--text-3)]">
                                      {desktopContextCaptureLoading
                                        ? 'Lume 正在读取启动或唤起前的前台窗口。'
                                        : desktopContextCaptureMessage ?? '请切回目标应用后重新打开 Lume。'}
                                    </div>
                                  </div>
                                </div>
                                {!desktopContextCaptureLoading && desktopContextPermissionRequestAvailable && onRequestDesktopContextPermissions ? (
                                  <Button
                                    variant="secondary"
                                    type="button"
                                    disabled={desktopContextPermissionRequestLoading}
                                    onClick={() => void onRequestDesktopContextPermissions()}
                                    className="mt-2 h-7 rounded-lg px-2 text-xs"
                                  >
                                    {desktopContextPermissionRequestLoading ? '等待系统授权' : '启动授权引导'}
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  {permissionModePicker}
                </>
              }
              trailingTools={
                <>
                  {composerModelPicker}
                  {thinkingLevelPicker}
                </>
              }
              footerClassName="border-t-0"
              actionSlot={
                composerState.showBusy ? (
                  <div className="inline-flex size-8 items-center justify-center rounded-lg bg-[var(--lume-accent)] text-[var(--lume-accent-foreground)]">
                    <Loader2 size={16} className="animate-spin" />
                  </div>
                ) : (
                  <Button
                    type="button"
                    aria-label="发送"
                    title="发送"
                    onClick={onSend}
                    disabled={!composerState.canSend}
                    className={cn(
                      'inline-flex size-8 items-center justify-center rounded-lg transition-colors duration-150 ease-out',
                      composerState.canSend
                        ? 'bg-[var(--lume-accent)] text-[var(--lume-accent-foreground)] hover:bg-[color:color-mix(in_oklab,var(--lume-accent)_88%,var(--lume-accent-2))]'
                        : 'cursor-not-allowed bg-[color:color-mix(in_oklab,var(--lume-accent)_40%,var(--lume-bg-elevated))] text-[var(--lume-accent-foreground)] opacity-55',
                    )}
                  >
                    <ArrowUp size={16} />
                  </Button>
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
          {!compact && suggestions && suggestions.length > 0 && (
            <div className="mt-4 flex w-full max-w-[840px] flex-wrap justify-center gap-2">
              {suggestions.map((suggestion) => (
                <Button
                variant="ghost"
                  key={suggestion.id}
                  type="button"
                  title={suggestion.prompt}
                  onClick={() => onSuggestionSelect?.(suggestion.prompt)}
                  disabled={sending}
                  className="inline-flex max-w-full items-center rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_46%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_82%,transparent)] px-3 py-1.5 text-[13px] text-[var(--text-2)] transition-colors hover:border-[color:color-mix(in_oklab,var(--lume-accent)_20%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-1)_96%,transparent)] hover:text-[var(--text-1)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="truncate">{suggestion.title}</span>
                </Button>
              ))}
            </div>
          )}
          {!compact && <p className="mt-3 text-center text-[12px] text-[var(--text-3)]">
            Lume 可能会犯错，请核查重要信息。
          </p>}
        </div>
      </div>
    </div>
  )
}

function HeroMark() {
  return (
    <div className="relative flex h-12 w-12 items-center justify-center text-[var(--lume-accent)]">
      <span className="absolute h-10 w-[2px] rounded-full bg-current" />
      <span className="absolute h-10 w-[2px] rotate-45 rounded-full bg-current" />
      <span className="absolute h-10 w-[2px] rotate-90 rounded-full bg-current" />
      <span className="absolute h-10 w-[2px] -rotate-45 rounded-full bg-current" />
      <span className="relative h-2 w-2 rounded-full bg-current" />
    </div>
  )
}
