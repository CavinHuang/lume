import { listChannels } from '@/lib/desktop-api/channel'
import { getEffectiveLumeConfig } from '@/lib/desktop-api/lume-config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
/**
 * ModelPicker - 线程模型覆盖选择器
 *
 * 展示当前线程的有效模型，并允许对当前线程设置或清除覆盖。
 * 支持搜索过滤。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { useAtom, useAtomValue } from 'jotai'
import { agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import { ModelOptionList } from '@/components/model-selection/ModelOptionList'
import { ChannelProviderIcon } from '@/components/model-selection/provider-icon-map'
import {
  composerControlChevronClassName,
  composerControlMenuClassName,
  composerControlTriggerClassName,
} from './composer-control-styles'
import {
  buildModelSelectionGroups,
  getThreadSelectionSummary,
} from '@/components/model-selection/model-selection-state'
import type { ModelOptionGroup, ModelSelectionOption } from '@/components/model-selection/model-selection-state'
import { AGENT_IPC_CHANNELS, type AgentThreadMeta, type Channel, type LumeConfigAgentDefaultStrategy } from '@lume/shared'
import { useModelMetaVersion } from '@/lib/model-meta-context'

interface ModelPickerProps {
  threadId: string
}

function mergeUpdatedThread(
  threads: AgentThreadMeta[],
  updatedThread: AgentThreadMeta
): AgentThreadMeta[] {
  return threads.map((thread) => (
    thread.id === updatedThread.id
      ? { ...thread, ...updatedThread }
      : thread
  ))
}

function filterGroups(
  groups: ModelOptionGroup[],
  searchTerm: string
): ModelOptionGroup[] {
  if (!searchTerm.trim()) return groups

  const lower = searchTerm.toLowerCase()
  return groups
    .map((group) => ({
      ...group,
      options: group.options.filter(
        (opt: ModelSelectionOption) =>
          opt.label.toLowerCase().includes(lower) ||
          opt.modelId.toLowerCase().includes(lower)
      ),
    }))
    .filter((group) => group.options.length > 0)
}

function isDefaultModelOption(
  option: ModelSelectionOption,
  defaultStrategy: LumeConfigAgentDefaultStrategy
): boolean {
  const defaultModelRef = defaultStrategy.defaultModelRef?.trim()
  if (!defaultModelRef || option.modelRef !== defaultModelRef) return false

  const defaultChannelId = defaultStrategy.defaultChannelId?.trim()
  return !defaultChannelId || option.channelId === defaultChannelId
}

export function ModelPicker({ threadId }: ModelPickerProps) {
  const [threads, setThreads] = useAtom(agentThreadsAtom)
  const thread = threads.find((item) => item.id === threadId)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  // 与 AgentInput 一致：用线程 workspace（回退到当前 workspace）解析 config slug，
  // 让默认模型/策略从 workspace effective config 读取，而非全局。
  const configWorkspaceSlug = useMemo(() => {
    const wsId = thread?.workspaceId ?? currentWorkspaceId
    return workspaces.find((w) => w.id === wsId)?.slug
  }, [thread?.workspaceId, currentWorkspaceId, workspaces])
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelsLoaded, setChannelsLoaded] = useState(false)
  const [defaultStrategy, setDefaultStrategy] = useState<LumeConfigAgentDefaultStrategy>({})
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listChannels()
      .then((items) => setChannels(items))
      .catch(console.error)
      .finally(() => setChannelsLoaded(true))
  }, [])

  useEffect(() => {
    getEffectiveLumeConfig(configWorkspaceSlug)
      .then((config) => setDefaultStrategy(config.models?.agent ?? {}))
      .catch(console.error)
  }, [configWorkspaceSlug])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  useEffect(() => {
    if (open) {
      setSearch('')
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
  }, [open])

  // 线程覆盖优先 → workspace 默认策略 → 回退到第一个可用模型
  // （与 WelcomeModelPicker 一致，避免 config 未配 models.agent 时显示"未设置"）
  const baseChannelId = thread?.channelId ?? defaultStrategy.defaultChannelId
  const baseModelRef = thread?.modelRef ?? defaultStrategy.defaultModelRef

  const modelMetaVersion = useModelMetaVersion()
  const groups = useMemo(() => buildModelSelectionGroups({
    channels,
    activeChannelId: baseChannelId,
    activeModelRef: baseModelRef,
  }), [channels, baseChannelId, baseModelRef, modelMetaVersion])

  const fallbackOption = !baseChannelId && !baseModelRef && channelsLoaded
    ? groups[0]?.options?.[0]
    : undefined
  const resolvedStrategy: LumeConfigAgentDefaultStrategy = fallbackOption
    ? { ...defaultStrategy, defaultChannelId: fallbackOption.channelId, defaultModelRef: fallbackOption.modelRef }
    : defaultStrategy

  const effectiveChannelId = thread?.channelId ?? resolvedStrategy.defaultChannelId

  const activeChannel = effectiveChannelId
    ? channels.find((c) => c.id === effectiveChannelId)
    : undefined

  const filteredGroups = useMemo(() => filterGroups(groups, search), [groups, search])

  const summary = useMemo(() => getThreadSelectionSummary({
    channels,
    channelsLoaded,
    thread,
    defaultStrategy: resolvedStrategy,
  }), [channels, channelsLoaded, thread, resolvedStrategy, modelMetaVersion])

  const canRestoreDefault = thread?.modelSelectionSource === 'thread-override'

  const handleSelect = async (input: {
    channelId: string
    modelRef: string
    modelId: string
  }) => {
    setOpen(false)

    try {
      const updatedThread = await sidecarCall<AgentThreadMeta>(AGENT_IPC_CHANNELS.UPDATE_THREAD_MODEL_SELECTION, {
        threadId,
        channelId: input.channelId,
        modelRef: input.modelRef,
        modelId: input.modelId,
      })
      setThreads((prev) => mergeUpdatedThread(prev, updatedThread))
    } catch (error) {
      console.error('[ModelPicker] 切换模型失败:', error)
    }
  }

  const handleRestoreDefault = async () => {
    setOpen(false)

    try {
      const updatedThread = await sidecarCall<AgentThreadMeta>(AGENT_IPC_CHANNELS.UPDATE_THREAD_MODEL_SELECTION, {
        threadId,
        channelId: null,
        modelRef: null,
        modelId: null,
      })
      setThreads((prev) => mergeUpdatedThread(prev, updatedThread))
    } catch (error) {
      console.error('[ModelPicker] 恢复默认策略失败:', error)
    }
  }

  if (groups.length === 0 && !summary.label) {
    return null
  }

  return (
    <div ref={menuRef} className="relative flex items-center gap-1.5">
      {/* Trigger button */}
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        className={composerControlTriggerClassName}
        title={summary.isUnavailable ? '当前线程模型不可用，点击重新选择' : '切换模型'}
      >
        {activeChannel && (
          <ChannelProviderIcon provider={activeChannel.provider} size={14} />
        )}
        <span className="lume-composer-control-label max-w-[160px] truncate">{summary.label}</span>
        <ChevronDown size={12} className={composerControlChevronClassName} />
      </Button>

      {summary.hasLoadedChannels && summary.isUnavailable && (
        <span className="lume-composer-control-status inline-flex h-6 items-center rounded-full border border-[color:color-mix(in_oklab,var(--lume-warning)_28%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,transparent)] px-2 text-[10.5px] font-medium text-[var(--lume-warning)]">
          当前模型不可用
        </span>
      )}

      {/* Dropdown */}
      {open && (
        <div
          className={cn(composerControlMenuClassName, 'z-[120] min-w-[260px] overflow-hidden')}
        >
          {/* Search */}
          <div className="border-b border-[var(--border)] p-1">
            <div className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--surface-2)] px-2">
              <Search size={13} className="text-muted-foreground/50 shrink-0" />
              <Input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索模型..."
                className="h-7 flex-1 border-0 bg-transparent px-0 py-0 text-xs text-foreground shadow-none outline-none placeholder:text-muted-foreground/50 focus-visible:ring-0"
              />
            </div>
          </div>

          <ScrollArea className="max-h-[304px]">
            {filteredGroups.length > 0 ? (
              <ModelOptionList
                groups={filteredGroups}
                onSelect={handleSelect}
                renderBadge={(option) => (
                  isDefaultModelOption(option, defaultStrategy)
                    ? (
                        <span className="shrink-0 rounded-full border border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_9%,var(--surface-1))] px-1.5 py-0.5 text-[10px] font-medium text-[var(--brand)]">
                          默认
                        </span>
                      )
                    : null
                )}
              />
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground/50">
                没有匹配的模型
              </div>
            )}
          </ScrollArea>

          {canRestoreDefault && (
            <div className="border-t border-border/50 p-1">
              <Button
                variant="ghost"
                onClick={handleRestoreDefault}
                className={cn(
                  'w-full justify-start rounded-md px-3 py-1.5 text-left text-[12px] transition-colors',
                  'text-foreground/70 hover:bg-muted/50 hover:text-foreground'
                )}
              >
                恢复默认策略
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
