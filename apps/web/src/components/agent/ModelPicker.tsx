/**
 * ModelPicker - 模型/渠道选择器
 *
 * 在 AgentInput 底部显示当前线程使用的模型，点击弹出下拉菜单切换。
 * 调用 agent:update-thread-model-selection 保存到后端。
 */

import { useState, useEffect, useRef } from 'react'
import { Cpu, ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAtom } from 'jotai'
import { agentThreadsAtom } from '@/atoms'
import { listChannels } from '@/lib/desktop-api/channel'
import { sidecarCall } from '@/lib/desktop-api'
import type { Channel, ChannelModel } from '@lume/shared'

interface ModelOption {
  channelId: string
  channelName: string
  model: ChannelModel
}

interface ModelPickerProps {
  threadId: string
}

export function ModelPicker({ threadId }: ModelPickerProps) {
  const [threads, setThreads] = useAtom(agentThreadsAtom)
  const thread = threads.find((t) => t.id === threadId)
  const [channels, setChannels] = useState<Channel[]>([])
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listChannels()
      .then((r) => setChannels((r.channels ?? []).filter((c) => c.enabled)))
      .catch(console.error)
  }, [])

  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  const options: ModelOption[] = channels.flatMap((c) =>
    c.models.filter((m) => m.enabled).map((model) => ({
      channelId: c.id,
      channelName: c.name,
      model,
    }))
  )

  const current = options.find(
    (o) => o.channelId === thread?.channelId && o.model.id === thread?.modelRef
  ) ?? options[0]

  const handleSelect = async (opt: ModelOption) => {
    setOpen(false)
    try {
      await sidecarCall('agent:update-thread-model-selection', {
        threadId,
        channelId: opt.channelId,
        modelRef: opt.model.id,
      })
      setThreads((prev) =>
        prev.map((t) =>
          t.id === threadId
            ? { ...t, channelId: opt.channelId, modelRef: opt.model.id }
            : t
        )
      )
    } catch (err) {
      console.error('[ModelPicker] 切换模型失败:', err)
    }
  }

  if (options.length === 0) return null

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11.5px] text-foreground/60 hover:bg-muted/50 hover:text-foreground/80 transition-colors"
        title="切换模型"
      >
        <Cpu size={11} />
        <span className="truncate max-w-[160px]">
          {current ? `${current.model.name}` : '选择模型'}
        </span>
        <ChevronDown size={10} className="text-foreground/40" />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="absolute bottom-full mb-1 left-0 z-50 min-w-[220px] max-h-[320px] overflow-y-auto rounded-lg border border-border/60 bg-popover shadow-lg py-1"
        >
          {channels.map((c) => {
            const enabledModels = c.models.filter((m) => m.enabled)
            if (enabledModels.length === 0) return null
            return (
              <div key={c.id} className="py-0.5">
                <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium text-foreground/40 uppercase tracking-wider">
                  {c.name}
                </div>
                {enabledModels.map((model) => {
                  const isActive = current?.channelId === c.id && current.model.id === model.id
                  return (
                    <button
                      key={`${c.id}-${model.id}`}
                      onClick={() => handleSelect({ channelId: c.id, channelName: c.name, model })}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors',
                        isActive
                          ? 'bg-accent text-accent-foreground'
                          : 'text-foreground/70 hover:bg-muted/50'
                      )}
                    >
                      <span className="flex-1 truncate">{model.name}</span>
                      {isActive && <Check size={12} className="text-primary" />}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
