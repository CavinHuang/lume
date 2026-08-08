import { useEffect, useState } from 'react'
import { Eye, EyeOff, Loader2, Plus, Trash2 } from 'lucide-react'
import type { ChannelCreateInput, ProviderType, ChannelModel, ProviderApiFamily, OpenAiApiMode } from '@lume/shared'
import { PROVIDER_LABELS, PROVIDER_DEFAULT_URLS, normalizeChannelModel } from '@lume/shared'
import { decryptChannelKey, fetchChannelModels, syncChannelModels, testChannelConnection } from '@/lib/desktop-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConnectionOAuthLogin } from './ConnectionOAuthLogin'

export interface ChannelFormValue extends ChannelCreateInput {}

interface Props {
  mode?: 'create' | 'edit'
  initialValue?: ChannelFormValue
  providerLocked?: boolean
  disabled?: boolean
  connectionId?: string
  onSubmit: (input: ChannelFormValue) => Promise<void>
  onSynced?: () => void
  onCancel?: () => void
  onDelete?: () => void
}

const PROVIDERS = Object.entries(PROVIDER_LABELS) as [ProviderType, string][]
const LOCAL_API_KEY_OPTIONAL_PROVIDERS = new Set<ProviderType>(['ollama', 'lmstudio'])
const OAUTH_PROVIDERS = new Set<ProviderType>([
  'anthropic',
  'openai-codex',
  'github-copilot',
  'openrouter',
  'kimi-coding',
  'xai',
])

export function isChannelApiKeyRequired(provider: ProviderType): boolean {
  return !LOCAL_API_KEY_OPTIONAL_PROVIDERS.has(provider)
}

function normalizeModelSearch(value: string): string {
  return value.trim().toLowerCase()
}

export function mergeChannelModels(existing: ChannelModel[], fetched: ChannelModel[]): ChannelModel[] {
  const fetchedIds = new Set(fetched.map((m) => m.id))
  const existingById = new Map(existing.map((model) => [model.id, model]))
  const preserved = existing.filter((model) =>
    !fetchedIds.has(model.id) && model.source !== 'discovered'
  )
  return [
    ...fetched.map((model) => {
      const previous = existingById.get(model.id)
      if (previous?.source !== 'discovered' && previous) {
        return { ...previous, source: 'manual' as const }
      }
      return {
        ...model,
        source: 'discovered' as const,
        enabled: previous?.enabled ?? true,
      }
    }),
    ...preserved.map((model) => ({ ...model, source: model.source ?? 'manual' as const })),
  ]
}

export function filterChannelModels(models: ChannelModel[], query: string): ChannelModel[] {
  const normalizedQuery = normalizeModelSearch(query)
  if (!normalizedQuery) return models
  return models.filter((model) => {
    const id = model.id.toLowerCase()
    const name = model.name.toLowerCase()
    return id.includes(normalizedQuery) || name.includes(normalizedQuery)
  })
}

export function setChannelModelsEnabled(
  models: ChannelModel[],
  modelIds: string[],
  enabled: boolean,
): ChannelModel[] {
  const selectedIds = new Set(modelIds)
  return models.map((model) => (
    selectedIds.has(model.id) ? { ...model, enabled } : model
  ))
}

export function invertChannelModelsEnabled(models: ChannelModel[], modelIds: string[]): ChannelModel[] {
  const selectedIds = new Set(modelIds)
  return models.map((model) => (
    selectedIds.has(model.id) ? { ...model, enabled: !model.enabled } : model
  ))
}

export function ChannelForm({
  mode = 'create',
  initialValue,
  providerLocked = false,
  disabled = false,
  connectionId,
  onSubmit,
  onCancel,
  onSynced,
  onDelete,
}: Props) {
  const [provider, setProvider] = useState<ProviderType>(initialValue?.provider ?? 'anthropic')
  const [name, setName] = useState(initialValue?.name ?? '')
  const [apiKey, setApiKey] = useState(initialValue?.apiKey ?? '')
  const [baseUrl, setBaseUrl] = useState(initialValue?.baseUrl ?? PROVIDER_DEFAULT_URLS['anthropic'])
  const [models, setModels] = useState<ChannelModel[]>(initialValue?.models ?? [])
  const [modelSearch, setModelSearch] = useState('')
  const [fetching, setFetching] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testMessage, setTestMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [fetchMsg, setFetchMsg] = useState('')
  const [apiFamily, setApiFamily] = useState<ProviderApiFamily>(
    initialValue?.apiFamily ?? 'openai'
  )
  const [openaiApiMode, setOpenaiApiMode] = useState<OpenAiApiMode>(
    initialValue?.openaiApiMode ?? 'chat-completions'
  )
  const [providerId, setProviderId] = useState(initialValue?.providerId ?? '')
  const [showApiKey, setShowApiKey] = useState(false)
  const [revealOpen, setRevealOpen] = useState(false)
  const [revealPassword, setRevealPassword] = useState('')
  const [revealError, setRevealError] = useState('')
  const [revealing, setRevealing] = useState(false)
  const [showAddModel, setShowAddModel] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [newModelName, setNewModelName] = useState('')
  const [addError, setAddError] = useState('')

  useEffect(() => {
    if (!initialValue) {
      setProvider('anthropic')
      setName('')
      setApiKey('')
      setBaseUrl(PROVIDER_DEFAULT_URLS.anthropic)
      setModels([])
      setModelSearch('')
      setFetchMsg('')
      setApiFamily('openai')
    setOpenaiApiMode('chat-completions')
    setProviderId('')
      setShowAddModel(false)
      setNewModelId('')
      setNewModelName('')
      setAddError('')
      return
    }

    setProvider(initialValue.provider)
    setName(initialValue.name)
    setApiKey(initialValue.apiKey)
    setBaseUrl(initialValue.baseUrl)
    setModels(initialValue.models)
    setModelSearch('')
    setFetchMsg('')
    setApiFamily(initialValue.apiFamily ?? 'openai')
    setOpenaiApiMode(initialValue.openaiApiMode ?? 'chat-completions')
    setProviderId(initialValue.providerId ?? '')
    setShowAddModel(false)
    setNewModelId('')
    setNewModelName('')
    setAddError('')
  }, [initialValue])

  const handleProviderChange = (p: ProviderType) => {
    setProvider(p)
    setBaseUrl(PROVIDER_DEFAULT_URLS[p])
    setModels([])
    setModelSearch('')
    setFetchMsg('')
    setOpenaiApiMode('chat-completions')
    setProviderId('')
  }

  const handleFetchModels = async () => {
    setFetching(true)
    setFetchMsg('')
    try {
      if (mode === 'edit' && connectionId) {
        const result = await syncChannelModels(connectionId)
        setModels(result.channel.models)
        setFetchMsg(result.success
          ? `同步完成：新增 ${result.added}，移除 ${result.removed}，手工保留 ${result.preservedManual}`
          : result.message)
        onSynced?.()
        return
      }
      const r = await fetchChannelModels({
        provider,
        baseUrl,
        apiKey,
        ...(provider === 'custom' ? { apiFamily } : {}),
        ...((provider === 'openai' || (provider === 'custom' && apiFamily === 'openai')) ? { openaiApiMode } : {}),
      })
      if (r.success) {
        setModels((prev) => mergeChannelModels(prev, r.models))
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

  const handleRevealApiKey = async () => {
    if (!connectionId) return
    setRevealError('')
    setRevealing(true)
    try {
      const value = await decryptChannelKey(connectionId, revealPassword)
      setApiKey(value)
      setShowApiKey(true)
      setRevealPassword('')
      setRevealOpen(false)
    } catch {
      setRevealError('密码不正确，或凭据保险库当前不可用。')
    } finally {
      setRevealing(false)
    }
  }

  const handleTestConnection = async () => {
    if (!connectionId) return
    setTesting(true)
    setTestMessage('')
    try {
      const result = await testChannelConnection(connectionId)
      setTestMessage(result.message)
      onSynced?.()
    } catch (error) {
      setTestMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(false)
    }
  }

  const handleAddModel = () => {
    const id = newModelId.trim()
    if (!id) {
      setAddError('请输入模型 ID')
      return
    }
    if (models.some((model) => model.id === id)) {
      setAddError('该模型已存在')
      return
    }
    const name = newModelName.trim() || id
    const normalized = normalizeChannelModel({ id, name, enabled: true, provider, source: 'manual' })
    setModels((prev) => [...prev, normalized])
    setNewModelId('')
    setNewModelName('')
    setAddError('')
    setShowAddModel(false)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await onSubmit({
        name: name || PROVIDER_LABELS[provider],
        provider,
        baseUrl,
        apiKey,
        authType: apiKey.trim() ? 'api-key' : initialValue?.authType,
        apiFamily: provider === 'custom' ? apiFamily : undefined,
        openaiApiMode: (provider === 'openai' || (provider === 'custom' && apiFamily === 'openai')) ? openaiApiMode : undefined,
        providerId: provider === 'custom' ? providerId || undefined : undefined,
        models,
        enabled: true,
      })
    } finally {
      setSaving(false)
    }
  }

  const visibleModels = filterChannelModels(models, modelSearch)
  const visibleModelIds = visibleModels.map((model) => model.id)
  const apiKeyRequired = isChannelApiKeyRequired(provider)
  const canRevealStoredApiKey = mode === 'edit'
    && Boolean(connectionId)
    && initialValue?.authType === 'api-key'
  const fieldClass = 'border-[color:color-mix(in_oklab,var(--border)_72%,transparent)] bg-[var(--surface-2)] text-[var(--text-1)] placeholder:text-[var(--text-3)] focus-visible:border-[color:color-mix(in_oklab,var(--brand)_42%,var(--border-strong))] focus-visible:ring-0'
  const selectClass = 'w-full border-[color:color-mix(in_oklab,var(--border)_72%,transparent)] bg-[var(--surface-2)] text-[var(--text-1)] focus-visible:border-[color:color-mix(in_oklab,var(--brand)_42%,var(--border-strong))] focus-visible:ring-0'
  const outlineButtonClass = 'h-8 rounded-[7px] border-[color:color-mix(in_oklab,var(--border)_72%,transparent)] bg-[var(--surface-2)] text-[12px] font-medium text-[var(--text-2)] shadow-none hover:bg-[var(--surface-3)] hover:text-[var(--text-1)] focus-visible:ring-0'
  const primaryButtonClass = 'h-8 rounded-[7px] bg-[var(--brand)] px-3 text-[12px] font-semibold text-[var(--brand-foreground)] hover:bg-[color:color-mix(in_oklab,var(--brand)_88%,var(--brand-2))] focus-visible:ring-0'

  return (
    <form onSubmit={handleSubmit} className="space-y-3 text-[var(--text-1)]">
      {/* 供应商（含协议） / Base URL（两列）*/}
      <div className="grid grid-cols-2 gap-3 items-start">
        <div className="space-y-2">
          {provider === 'custom' ? (
            <div className="space-y-1.5">
              <Label>协议类型</Label>
              <Select
                value={apiFamily === 'openai' ? `openai-${openaiApiMode}` : apiFamily}
                onValueChange={(v) => {
                  if (v === 'openai-chat-completions') { setApiFamily('openai'); setOpenaiApiMode('chat-completions') }
                  else if (v === 'openai-responses') { setApiFamily('openai'); setOpenaiApiMode('responses') }
                  else { setApiFamily(v as ProviderApiFamily); setOpenaiApiMode('chat-completions') }
                }}
                disabled={disabled}
              >
                <SelectTrigger className={selectClass}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai-chat-completions">OpenAI (Chat Completions)</SelectItem>
                  <SelectItem value="openai-responses">OpenAI (Responses)</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="google">Google Gen AI</SelectItem>
                </SelectContent>
              </Select>
              <Label className="text-[11px]">标识符</Label>
              <Input value={providerId} onChange={(e) => setProviderId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))} placeholder="my-openai" className={cn(fieldClass, 'font-mono text-[12px]')} disabled={disabled} />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>供应商</Label>
              <Select value={provider} onValueChange={(v) => { if (v) handleProviderChange(v as ProviderType) }} disabled={providerLocked || disabled}>
                <SelectTrigger className={selectClass}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map(([id, label]) => (
                    <SelectItem key={id} value={id}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {provider === 'openai' && (
                <div className="space-y-1.5">
                  <Label className="text-[11px]">协议类型</Label>
                  <Select value={`openai-${openaiApiMode}`} onValueChange={(v) => { if (v) setOpenaiApiMode(v.replace('openai-', '') as OpenAiApiMode) }} disabled={disabled}>
                    <SelectTrigger className={selectClass}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai-chat-completions">Chat Completions</SelectItem>
                      <SelectItem value="openai-responses">Responses</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>Base URL</Label>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={cn(fieldClass, 'font-mono text-[12px]')} disabled={disabled} />
        </div>
      </div>

      {/* API Key / 显示名称（两列）*/}
      <div className="grid grid-cols-2 gap-3 items-start">
        <div className="space-y-1.5">
          <Label>{initialValue?.authType === 'oauth' && !apiKey ? 'API Key（填写后切换）' : 'API Key'}</Label>
          <div className="relative">
            <Input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={mode === 'edit' ? '留空保持当前凭据' : apiKeyRequired ? 'sk-...' : '本地服务可留空'}
              className={cn(fieldClass, (apiKey || canRevealStoredApiKey) && 'pr-9', 'font-mono text-[12px]')}
              disabled={disabled}
            />
            {(apiKey || canRevealStoredApiKey) && (
              <Button
                variant="ghost"
                type="button"
                onClick={() => {
                  if (canRevealStoredApiKey && connectionId && !apiKey) { setRevealOpen(true); return }
                  setShowApiKey((value) => !value)
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)] hover:text-[var(--text-1)]"
                tabIndex={-1}
              >
                {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
            )}
          </div>
          {mode === 'edit' && connectionId && OAUTH_PROVIDERS.has(provider) && (
            <div className="flex items-center justify-end pt-1">
              <ConnectionOAuthLogin connectionId={connectionId} onCompleted={() => void handleFetchModels()} />
            </div>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>显示名称</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={PROVIDER_LABELS[provider]} className={fieldClass} disabled={disabled} />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>模型</Label>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => { setShowAddModel((v) => !v); setAddError('') }}
              disabled={disabled}
              className={outlineButtonClass}
            >
              <Plus size={11} className="mr-1" />
              手动添加
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleFetchModels} disabled={disabled || fetching || (mode === 'create' && apiKeyRequired && !apiKey)} className={outlineButtonClass}>
              {fetching && <Loader2 size={11} className="animate-spin mr-1" />}
              {mode === 'edit' ? '同步模型' : '拉取模型列表'}
            </Button>
          </div>
        </div>
        {showAddModel && (
          <div className="space-y-2 rounded-[8px] bg-[var(--surface-2)] p-3">
            <div className="space-y-1">
              <Label className="text-[11px]">模型 ID</Label>
              <Input
                value={newModelId}
                onChange={(e) => { setNewModelId(e.target.value); setAddError('') }}
                placeholder="claude-sonnet-4-5"
                className={cn(fieldClass, 'h-8 font-mono text-[12px]')}
                disabled={disabled}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">显示名（可选）</Label>
              <Input
                value={newModelName}
                onChange={(e) => setNewModelName(e.target.value)}
                placeholder={newModelId.trim() || '默认使用模型 ID'}
                className={cn(fieldClass, 'h-8 text-[12px]')}
                disabled={disabled}
              />
            </div>
            {addError && <p className="text-[11px] text-[var(--lume-danger)]">{addError}</p>}
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={handleAddModel} disabled={disabled} className={primaryButtonClass}>添加</Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 rounded-[7px] text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-3)] hover:text-[var(--text-1)] focus-visible:ring-0"
                onClick={() => { setShowAddModel(false); setNewModelId(''); setNewModelName(''); setAddError('') }}
              >
                取消
              </Button>
            </div>
          </div>
        )}
        {fetchMsg && <p className="text-[11px] text-[var(--text-3)]">{fetchMsg}</p>}
        {models.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                placeholder="搜索模型 ID 或名称"
                className={cn(fieldClass, 'h-8 text-[12px]')}
                disabled={disabled}
              />
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || visibleModelIds.length === 0}
                  onClick={() => setModels((prev) => setChannelModelsEnabled(prev, visibleModelIds, true))}
                  className={outlineButtonClass}
                >
                  全选
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled || visibleModelIds.length === 0}
                  onClick={() => setModels((prev) => invertChannelModelsEnabled(prev, visibleModelIds))}
                  className={outlineButtonClass}
                >
                  反选
                </Button>
              </div>
            </div>
            {modelSearch.trim() && (
              <p className="text-[11px] text-[var(--text-3)]">匹配 {visibleModels.length} / {models.length} 个模型</p>
            )}
            <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
              {visibleModels.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => setModels((prev) => prev.map((x) => x.id === m.id ? { ...x, enabled: !x.enabled } : x))}
                  className={cn(
                    'rounded-md border px-2 py-1 font-mono text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    m.enabled
                      ? 'border-[color:color-mix(in_oklab,var(--brand)_42%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                      : 'border-[color:color-mix(in_oklab,var(--border)_72%,transparent)] bg-[var(--surface-2)] text-[var(--text-3)] hover:text-[var(--text-1)]'
                  )}
                >
                  {m.id}
                </button>
              ))}
              {visibleModels.length === 0 && (
                <span className="py-3 text-[12px] text-[var(--text-3)]">没有匹配的模型</span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        {testMessage && <p className="mr-auto text-[11px] text-[var(--text-3)]">{testMessage}</p>}
        {mode === 'edit' && connectionId && (
          <Button type="button" variant="outline" onClick={() => void handleTestConnection()} disabled={disabled || testing} className={outlineButtonClass}>
            {testing && <Loader2 size={13} className="mr-1 animate-spin" />}
            测试连接
          </Button>
        )}
        {mode === 'edit' && connectionId && onDelete && (
          <Button
            type="button"
            variant="outline"
            onClick={onDelete}
            className="h-8 gap-1.5 rounded-[7px] border-[color:color-mix(in_oklab,var(--lume-danger)_34%,var(--border))] bg-transparent px-3 text-[12px] font-medium text-[var(--lume-danger)] shadow-none hover:bg-[color-mix(in_oklab,var(--lume-danger)_8%,var(--surface-1))]"
          >
            <Trash2 size={13} />
            删除连接
          </Button>
        )}
        <Button type="submit" disabled={disabled || saving || (mode === 'create' && apiKeyRequired && !apiKey)} className={primaryButtonClass}>
          {saving && <Loader2 size={13} className="animate-spin mr-1" />}
          {mode === 'edit' ? '保存修改' : '保存'}
        </Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel} className="h-8 rounded-[7px] text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-3)] hover:text-[var(--text-1)] focus-visible:ring-0">取消</Button>}
      </div>

      <Dialog open={revealOpen} onOpenChange={setRevealOpen}>
        <DialogContent showCloseButton={!revealing}>
          <DialogHeader>
            <DialogTitle>查看连接凭据</DialogTitle>
            <DialogDescription>请输入初始化 Lume 时设置的本地密码。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reveal-connection-password">本地密码</Label>
            <Input
              id="reveal-connection-password"
              type="password"
              autoComplete="current-password"
              value={revealPassword}
              disabled={revealing}
              onChange={(event) => setRevealPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleRevealApiKey()
                }
              }}
            />
            {revealError && <p className="text-sm text-destructive">{revealError}</p>}
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => void handleRevealApiKey()} disabled={revealing || !revealPassword}>
              {revealing ? '正在验证…' : '查看'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  )
}
