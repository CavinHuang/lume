/**
 * ModelPicker - 线程模型覆盖选择器
 *
 * 展示当前线程的有效模型，并允许对当前线程设置或清除覆盖。
 * 支持搜索过滤。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { useAtom } from 'jotai'
import { agentThreadsAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { listChannels } from '@/lib/desktop-api/channel'
import { cn } from '@/lib/utils'
import { ModelOptionList } from '@/components/model-selection/ModelOptionList'
import { ChannelProviderIcon } from '@/components/model-selection/provider-icon-map'
import {
  buildModelSelectionGroups,
  getThreadSelectionSummary,
} from '@/components/model-selection/model-selection-state'
import type { ModelOptionGroup, ModelSelectionOption } from '@/components/model-selection/model-selection-state'
import type { AgentThreadMeta, Channel, LumeConfigAgentDefaultStrategy } from '@lume/shared'
import { getEffectiveLumeConfig } from '@/lib/desktop-api/lume-config'

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

export function ModelPicker({ threadId }: ModelPickerProps) {
  const [threads, setThreads] = useAtom(agentThreadsAtom)
  const thread = threads.find((item) => item.id === threadId)
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

    getEffectiveLumeConfig()
      .then((config) => setDefaultStrategy(config.models?.agent ?? {}))
      .catch(console.error)
  }, [])

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

  /** 计算有效模型选择：线程覆盖优先，否则回退到全局默认策略 */
  const effectiveChannelId = thread?.channelId ?? defaultStrategy.defaultChannelId
  const effectiveModelRef = thread?.modelRef ?? defaultStrategy.defaultModelRef

  const activeChannel = effectiveChannelId
    ? channels.find(c => c.id === effectiveChannelId)
    : undefined

  const groups = useMemo(() => buildModelSelectionGroups({
    channels,
    activeChannelId: effectiveChannelId,
    activeModelRef: effectiveModelRef,
  }), [channels, effectiveChannelId, effectiveModelRef])

  const filteredGroups = useMemo(() => filterGroups(groups, search), [groups, search])

  const summary = useMemo(() => getThreadSelectionSummary({
    channels,
    channelsLoaded,
    thread,
    defaultStrategy,
  }), [channels, channelsLoaded, thread, defaultStrategy])

  const canRestoreDefault = thread?.modelSelectionSource === 'thread-override'

  const handleSelect = async (input: {
    channelId: string
    modelRef: string
    modelId: string
  }) => {
    setOpen(false)

    try {
      const updatedThread = await sidecarCall<AgentThreadMeta>('agent:update-thread-model-selection', {
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
      const updatedThread = await sidecarCall<AgentThreadMeta>('agent:update-thread-model-selection', {
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
    <div className="relative flex items-center gap-1.5">
      {/* Trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11.5px] text-foreground/60 hover:bg-muted/50 hover:text-foreground/80 transition-colors"
        title={summary.isUnavailable ? '当前线程模型不可用，点击重新选择' : '切换模型'}
      >
        {activeChannel && (
          <ChannelProviderIcon provider={activeChannel.provider} size={11} />
        )}
        <span className="truncate max-w-[160px]">{summary.label}</span>
        <ChevronDown size={10} className="text-foreground/40" />
      </button>

      {canRestoreDefault && (
        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
          已覆盖默认
        </span>
      )}
      {summary.hasLoadedChannels && summary.isUnavailable && (
        <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
          当前模型不可用
        </span>
      )}

      {/* Dropdown */}
      {open && (
        <div
          ref={menuRef}
          className="absolute bottom-full mb-1 left-0 z-50 min-w-[260px] max-h-[360px] overflow-y-auto rounded-lg border border-border/60 bg-popover shadow-lg"
        >
          {/* Search */}
          <div className="p-1.5 border-b border-border/40">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50">
              <Search size={13} className="text-muted-foreground/50 shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索模型..."
                className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none"
              />
            </div>
          </div>

          {filteredGroups.length > 0 ? (
            <ModelOptionList groups={filteredGroups} onSelect={handleSelect} />
          ) : (
            <div className="py-6 text-center text-xs text-muted-foreground/50">
              没有匹配的模型
            </div>
          )}

          {canRestoreDefault && (
            <div className="border-t border-border/50 p-1">
              <button
                onClick={handleRestoreDefault}
                className={cn(
                  'w-full rounded-md px-3 py-1.5 text-left text-[12px] transition-colors',
                  'text-foreground/70 hover:bg-muted/50 hover:text-foreground'
                )}
              >
                恢复默认策略
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
