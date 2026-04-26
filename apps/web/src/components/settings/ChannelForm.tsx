import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ChannelCreateInput, ProviderType, ChannelModel } from '@lume/shared'
import { PROVIDER_LABELS, PROVIDER_DEFAULT_URLS } from '@lume/shared'
import { fetchChannelModels } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export interface ChannelFormValue extends ChannelCreateInput {}

interface Props {
  mode?: 'create' | 'edit'
  initialValue?: ChannelFormValue
  providerLocked?: boolean
  disabled?: boolean
  onSubmit: (input: ChannelFormValue) => Promise<void>
  onCancel?: () => void
}

const PROVIDERS = Object.entries(PROVIDER_LABELS) as [ProviderType, string][]

export function ChannelForm({
  mode = 'create',
  initialValue,
  providerLocked = false,
  disabled = false,
  onSubmit,
  onCancel,
}: Props) {
  const [provider, setProvider] = useState<ProviderType>(initialValue?.provider ?? 'anthropic')
  const [name, setName] = useState(initialValue?.name ?? '')
  const [apiKey, setApiKey] = useState(initialValue?.apiKey ?? '')
  const [baseUrl, setBaseUrl] = useState(initialValue?.baseUrl ?? PROVIDER_DEFAULT_URLS['anthropic'])
  const [models, setModels] = useState<ChannelModel[]>(initialValue?.models ?? [])
  const [fetching, setFetching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [fetchMsg, setFetchMsg] = useState('')

  useEffect(() => {
    if (!initialValue) {
      setProvider('anthropic')
      setName('')
      setApiKey('')
      setBaseUrl(PROVIDER_DEFAULT_URLS.anthropic)
      setModels([])
      setFetchMsg('')
      return
    }

    setProvider(initialValue.provider)
    setName(initialValue.name)
    setApiKey(initialValue.apiKey)
    setBaseUrl(initialValue.baseUrl)
    setModels(initialValue.models)
    setFetchMsg('')
  }, [initialValue])

  const handleProviderChange = (p: ProviderType) => {
    setProvider(p)
    setBaseUrl(PROVIDER_DEFAULT_URLS[p])
    setModels([])
    setFetchMsg('')
  }

  const handleFetchModels = async () => {
    setFetching(true)
    setFetchMsg('')
    try {
      const r = await fetchChannelModels({ provider, baseUrl, apiKey })
      if (r.success) {
        setModels(r.models)
        setFetchMsg(`获取到 ${r.models.length} 个模型`)
      } else {
        setFetchMsg(r.message)
      }
    } catch (e: any) {
      setFetchMsg(e?.message ?? '请求失败')
    } finally {
      setFetching(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await onSubmit({ name: name || PROVIDER_LABELS[provider], provider, baseUrl, apiKey, models, enabled: true })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 max-w-lg">
      <div>
        <h2 className="text-[15px] font-semibold">{mode === 'edit' ? '编辑渠道' : '添加渠道'}</h2>
        <p className="text-[12px] text-muted-foreground mt-0.5">
          {disabled ? '开启后即可填写该供应商的连接信息' : mode === 'edit' ? '更新当前渠道配置' : '配置 AI 供应商连接'}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>供应商</Label>
        <Select
          value={provider}
          onValueChange={(v) => handleProviderChange(v as ProviderType)}
          disabled={providerLocked || disabled}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {PROVIDERS.map(([id, label]) => (
              <SelectItem key={id} value={id}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label>名称</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={PROVIDER_LABELS[provider]} disabled={disabled} />
      </div>

      <div className="space-y-1.5">
        <Label>Base URL</Label>
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="font-mono text-[12px]" disabled={disabled} />
      </div>

      <div className="space-y-1.5">
        <Label>API Key</Label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          className="font-mono text-[12px]"
          disabled={disabled}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>模型</Label>
          <Button type="button" variant="outline" size="sm" onClick={handleFetchModels} disabled={disabled || fetching || !apiKey}>
            {fetching && <Loader2 size={11} className="animate-spin mr-1" />}
            拉取模型列表
          </Button>
        </div>
        {fetchMsg && <p className="text-[11px] text-muted-foreground">{fetchMsg}</p>}
        {models.length > 0 && (
          <ScrollArea className="max-h-48 rounded-lg border">
            <div className="divide-y">
              {models.map((m) => (
                <label key={m.id} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    disabled={disabled}
                    onChange={(e) => setModels((prev) => prev.map((x) => x.id === m.id ? { ...x, enabled: e.target.checked } : x))}
                  />
                  <span className="text-[12px] font-mono truncate">{m.id}</span>
                </label>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button type="submit" disabled={disabled || saving || (mode === 'create' && !apiKey)}>
          {saving && <Loader2 size={13} className="animate-spin mr-1" />}
          {mode === 'edit' ? '保存修改' : '保存'}
        </Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>取消</Button>}
      </div>
    </form>
  )
}
