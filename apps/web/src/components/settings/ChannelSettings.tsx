import { useEffect, useState } from 'react'
import { Plus, Trash2, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { listChannels, createChannel, deleteChannel } from '@/lib/desktop-api'
import type { Channel, ChannelCreateInput } from '@lume/shared'
import { PROVIDER_LABELS } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { ChannelForm } from './ChannelForm'

export function ChannelSettings() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [selected, setSelected] = useState<Channel | null>(null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listChannels()
      .then((r) => setChannels(r.channels ?? []))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const handleCreate = async (input: ChannelCreateInput) => {
    const ch = await createChannel(input)
    setChannels((prev) => [...prev, ch])
    setCreating(false)
    setSelected(ch)
  }

  const handleDelete = async (id: string) => {
    await deleteChannel(id)
    setChannels((prev) => prev.filter((c) => c.id !== id))
    if (selected?.id === id) setSelected(null)
  }

  if (creating) {
    return (
      <div className="p-6">
        <ChannelForm onSubmit={handleCreate} onCancel={() => setCreating(false)} />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-semibold">渠道</h2>
          <p className="text-[12px] text-muted-foreground mt-0.5">配置 AI 供应商 API 连接</p>
        </div>
        <Button size="sm" onClick={() => { setCreating(true); setSelected(null) }}>
          <Plus size={13} />
          添加渠道
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-[13px]">
          <Loader2 size={14} className="animate-spin" />加载中...
        </div>
      ) : channels.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <p className="text-[13px] text-muted-foreground">暂无渠道，点击「添加渠道」开始配置</p>
        </div>
      ) : (
        <div className="space-y-2">
          {channels.map((ch) => (
            <div
              key={ch.id}
              onClick={() => setSelected(ch)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-colors',
                selected?.id === ch.id ? 'border-foreground/20 bg-muted/50' : 'hover:bg-muted/30'
              )}
            >
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium truncate">{ch.name}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {PROVIDER_LABELS[ch.provider]} · {ch.models.filter(m => m.enabled).length} 个模型
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={cn('size-1.5 rounded-full', ch.enabled ? 'bg-green-500' : 'bg-muted-foreground/30')} />
                <Button
                  variant="ghost" size="icon"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); handleDelete(ch.id) }}
                >
                  <Trash2 size={13} />
                </Button>
                <ChevronRight size={13} className="text-muted-foreground" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
