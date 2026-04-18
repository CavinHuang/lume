import { useEffect, useMemo, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import type { Channel, ProviderType } from '@lume/shared'
import { PROVIDER_DEFAULT_URLS, PROVIDER_LABELS } from '@lume/shared'
import { createChannel, decryptChannelKey, listChannels, updateChannel } from '@/lib/desktop-api'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { ChannelForm, type ChannelFormValue } from './ChannelForm'

export interface ProviderItem {
  provider: ProviderType
  label: string
  channel: Channel | null
}

const PROVIDER_OPTIONS = Object.entries(PROVIDER_LABELS) as [ProviderType, string][]
export const PROVIDER_LIST_SCROLLAREA_CLASS = 'h-full min-h-0 rounded-2xl border bg-background/40'

export function buildProviderItems(channels: Channel[]): ProviderItem[] {
  return PROVIDER_OPTIONS
    .map(([provider, label], index) => ({
      provider,
      label,
      channel: channels.find((channel) => channel.provider === provider) ?? null,
      index,
    }))
    .sort((a, b) => {
      const aRank = a.channel?.enabled ? 0 : a.channel ? 1 : 2
      const bRank = b.channel?.enabled ? 0 : b.channel ? 1 : 2
      return aRank - bRank || a.index - b.index
    })
    .map(({ provider, label, channel }) => ({ provider, label, channel }))
}

export function getProviderFormInitialValue(
  provider: ProviderType,
  channels: Channel[],
  apiKey: string
): ChannelFormValue {
  const existing = channels.find((channel) => channel.provider === provider)
  if (!existing) {
    return {
      name: PROVIDER_LABELS[provider],
      provider,
      baseUrl: PROVIDER_DEFAULT_URLS[provider],
      apiKey,
      models: [],
      defaultModelId: undefined,
      fallbackModelIds: undefined,
      enabled: false,
    }
  }

  return {
    name: existing.name,
    provider: existing.provider,
    baseUrl: existing.baseUrl,
    apiKey,
    models: existing.models,
    defaultModelId: existing.defaultModelId,
    fallbackModelIds: existing.fallbackModelIds,
    enabled: existing.enabled,
  }
}

export function ChannelSettings() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [activeProvider, setActiveProvider] = useState<ProviderType>('anthropic')
  const [loading, setLoading] = useState(true)
  const [apiKeyLoading, setApiKeyLoading] = useState(false)
  const [selectedApiKey, setSelectedApiKey] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [savingEnabled, setSavingEnabled] = useState(false)

  useEffect(() => {
    listChannels()
      .then((nextChannels) => {
        setChannels(nextChannels)
        setActiveProvider((prev) => nextChannels.some((channel) => channel.provider === prev) ? prev : nextChannels[0]?.provider ?? 'anthropic')
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const providerItems = useMemo(() => buildProviderItems(channels), [channels])
  const activeItem = useMemo(
    () => providerItems.find((item) => item.provider === activeProvider) ?? providerItems[0] ?? null,
    [activeProvider, providerItems]
  )
  const activeChannel = activeItem?.channel ?? null

  useEffect(() => {
    if (!activeChannel) {
      setSelectedApiKey('')
      setEnabled(false)
      setApiKeyLoading(false)
      return
    }

    setEnabled(activeChannel.enabled)
    setApiKeyLoading(true)
    decryptChannelKey(activeChannel.id)
      .then((apiKey) => setSelectedApiKey(apiKey))
      .catch((error) => {
        console.error(error)
        setSelectedApiKey('')
      })
      .finally(() => setApiKeyLoading(false))
  }, [activeChannel?.id, activeChannel?.enabled])

  const formInitialValue = useMemo(
    () => getProviderFormInitialValue(activeProvider, channels, activeChannel ? selectedApiKey : ''),
    [activeChannel, activeProvider, channels, selectedApiKey]
  )

  const handlePersist = async (input: ChannelFormValue) => {
    const payload = { ...input, enabled }

    if (activeChannel) {
      const updated = await updateChannel(activeChannel.id, payload)
      setChannels((prev) => prev.map((channel) => (channel.id === updated.id ? updated : channel)))
      setSelectedApiKey(input.apiKey)
      setEnabled(updated.enabled)
      return
    }

    const created = await createChannel(payload)
    setChannels((prev) => [...prev.filter((channel) => channel.provider !== created.provider), created])
    setSelectedApiKey(input.apiKey)
    setEnabled(created.enabled)
  }

  const handleEnabledChange = async (checked: boolean) => {
    setEnabled(checked)
    if (!activeChannel) return
    setSavingEnabled(true)
    try {
      const updated = await updateChannel(activeChannel.id, { enabled: checked })
      setChannels((prev) => prev.map((channel) => (channel.id === updated.id ? updated : channel)))
    } finally {
      setSavingEnabled(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 text-muted-foreground text-[13px]">
          <Loader2 size={14} className="animate-spin" />加载中...
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 p-6 flex flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold">供应商配置</h2>
        <p className="text-[12px] text-muted-foreground mt-0.5">按供应商管理模型连接，已配置项会显示绿色标记</p>
      </div>

      <div className="min-h-0 flex-1 grid gap-4 lg:grid-cols-[minmax(220px,280px)_1fr]">
        <ScrollArea className={PROVIDER_LIST_SCROLLAREA_CLASS}>
          <div className="space-y-2 p-3">
            {providerItems.map((item) => {
              const configured = Boolean(item.channel)
              const selected = item.provider === activeProvider
              return (
                <button
                  key={item.provider}
                  onClick={() => setActiveProvider(item.provider)}
                  className={cn(
                    'w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-colors',
                    selected ? 'border-foreground/20 bg-muted/50' : 'hover:bg-muted/30'
                  )}
                >
                  <span className={cn('size-2 rounded-full', configured ? 'bg-green-500' : 'bg-muted-foreground/30')} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium truncate">{item.label}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {configured ? '已配置' : '未配置'}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        </ScrollArea>

        <div className="min-h-0 rounded-2xl border bg-background/70 p-5 space-y-5 overflow-y-auto">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-[15px] font-semibold">{PROVIDER_LABELS[activeProvider]}</h3>
              <p className="text-[12px] text-muted-foreground">
                {activeChannel ? '已存在该供应商配置，开启后可编辑并保存。' : '尚未配置该供应商，开启后即可填写连接信息。'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {savingEnabled && <Loader2 size={13} className="animate-spin text-muted-foreground" />}
              <span className="text-[12px] text-muted-foreground">开启</span>
              <Switch checked={enabled} onCheckedChange={handleEnabledChange} />
            </div>
          </div>

          {apiKeyLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-[13px]">
              <Loader2 size={14} className="animate-spin" />加载渠道详情...
            </div>
          ) : (
            <ChannelForm
              mode={activeChannel ? 'edit' : 'create'}
              initialValue={formInitialValue}
              providerLocked
              disabled={!enabled}
              onSubmit={handlePersist}
            />
          )}

          {enabled && (
            <div className="rounded-xl border border-dashed px-4 py-3 text-[12px] text-muted-foreground flex items-center gap-2">
              <Save size={13} />
              填好配置后点击下方保存，未开启时不会提交该供应商配置。
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
