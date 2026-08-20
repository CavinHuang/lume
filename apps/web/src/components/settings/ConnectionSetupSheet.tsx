import { createChannel, syncChannelModels } from '@/lib/desktop-api/channel'
import * as React from 'react'
import { Check, ChevronLeft, Loader2, Search } from 'lucide-react'
import type { Channel, OpenAiApiMode, ProviderApiFamily, ProviderType } from '@lume/shared'
import { PROVIDER_DEFAULT_URLS, PROVIDER_GROUPS, PROVIDER_LABELS } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ChannelProviderIcon } from '@/components/model-selection/provider-icon-map'
import { cn } from '@/lib/utils'
import { ConnectionOAuthLogin } from './ConnectionOAuthLogin'

const OAUTH_PROVIDERS = new Set<ProviderType>([
  'anthropic', 'openai-codex', 'github-copilot', 'openrouter', 'kimi-coding', 'xai',
])
const OAUTH_ONLY_PROVIDERS = new Set<ProviderType>(['openai-codex', 'github-copilot'])
const KEY_OPTIONAL_PROVIDERS = new Set<ProviderType>(['ollama', 'lmstudio'])

type AuthMode = 'api-key' | 'oauth' | 'none'

export function ConnectionSetupSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (connectionId: string) => void
}) {
  const [step, setStep] = React.useState<1 | 2 | 3>(1)
  const [provider, setProvider] = React.useState<ProviderType>('anthropic')
  const [query, setQuery] = React.useState('')
  const [name, setName] = React.useState(PROVIDER_LABELS.anthropic)
  const [baseUrl, setBaseUrl] = React.useState(PROVIDER_DEFAULT_URLS.anthropic)
  const [providerId, setProviderId] = React.useState('')
  const [apiKey, setApiKey] = React.useState('')
  const [authMode, setAuthMode] = React.useState<AuthMode>('oauth')
  const [apiFamily, setApiFamily] = React.useState<ProviderApiFamily>('openai')
  const [openaiApiMode, setOpenaiApiMode] = React.useState<OpenAiApiMode>('chat-completions')
  const [created, setCreated] = React.useState<Channel | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [syncing, setSyncing] = React.useState(false)
  const [syncMessage, setSyncMessage] = React.useState('')
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    if (!open) return
    setStep(1)
    setProvider('anthropic')
    setQuery('')
    setName(PROVIDER_LABELS.anthropic)
    setBaseUrl(PROVIDER_DEFAULT_URLS.anthropic)
    setProviderId('')
    setApiKey('')
    setAuthMode('oauth')
    setApiFamily('openai')
    setOpenaiApiMode('chat-completions')
    setCreated(null)
    setSyncMessage('')
    setError('')
  }, [open])

  const providers = React.useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return (Object.entries(PROVIDER_LABELS) as [ProviderType, string][]).filter(([id, label]) => (
      !normalized || id.includes(normalized) || label.toLowerCase().includes(normalized)
    ))
  }, [query])

  const selectProvider = (next: ProviderType) => {
    setProvider(next)
    setName(PROVIDER_LABELS[next])
    setBaseUrl(PROVIDER_DEFAULT_URLS[next])
    setApiKey('')
    setApiFamily('openai')
    setOpenaiApiMode('chat-completions')
    setAuthMode(OAUTH_PROVIDERS.has(next) ? 'oauth' : KEY_OPTIONAL_PROVIDERS.has(next) ? 'none' : 'api-key')
    setError('')
    setStep(2)
  }

  const createConnection = async () => {
    if (!name.trim()) return setError('请输入连接名称')
    if (!baseUrl.trim()) return setError('请输入 Base URL')
    if (provider === 'custom' && !providerId.trim()) return setError('请输入供应商标识')
    if (authMode === 'api-key' && !apiKey.trim()) return setError('请输入 API Key')
    setSaving(true)
    setError('')
    try {
      const channel = await createChannel({
        name: name.trim(),
        provider,
        baseUrl: baseUrl.trim(),
        apiKey: authMode === 'api-key' ? apiKey : '',
        authType: authMode === 'oauth' ? 'none' : authMode,
        apiFamily: provider === 'custom' ? apiFamily : undefined,
        providerId: provider === 'custom' ? providerId.trim() : undefined,
        openaiApiMode: provider === 'openai' || (provider === 'custom' && apiFamily === 'openai')
          ? openaiApiMode
          : undefined,
        models: [],
        enabled: true,
      })
      setCreated(channel)
      setStep(3)
      onCreated(channel.id)
      if (authMode !== 'oauth') await syncModels(channel.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const syncModels = async (connectionId = created?.id) => {
    if (!connectionId) return
    setSyncing(true)
    setSyncMessage('')
    try {
      const result = await syncChannelModels(connectionId)
      setCreated(result.channel)
      setSyncMessage(result.success
        ? `已同步 ${result.channel.models.length} 个模型，新模型已直接启用。`
        : result.message)
      onCreated(connectionId)
    } catch (cause) {
      setSyncMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!inset-y-0 !right-0 !left-auto !top-0 !h-dvh !w-[min(560px,calc(100vw-24px))] !max-w-none !translate-x-0 !translate-y-0 !rounded-none !rounded-l-2xl p-0">
        <div className="flex min-h-0 flex-1 flex-col">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>添加连接</DialogTitle>
            <DialogDescription>选择供应商，完成账号连接，再同步可用模型。</DialogDescription>
            <div className="grid grid-cols-3 gap-2 pt-2">
              {['选择供应商', '连接账号', '同步模型'].map((label, index) => {
                const number = index + 1
                return (
                  <div key={label} className={cn('flex items-center gap-2 text-xs', number <= step ? 'text-foreground' : 'text-muted-foreground')}>
                    <span className={cn('grid size-6 place-items-center rounded-full border', number < step && 'border-primary bg-primary text-primary-foreground')}>
                      {number < step ? <Check size={13} /> : number}
                    </span>
                    {label}
                  </div>
                )
              })}
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {step === 1 && (
              <div className="space-y-4">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索供应商" className="pl-9" />
                </div>
                {PROVIDER_GROUPS.filter((group) => group.key !== 'all').map((group) => {
                  const rows = providers.filter(([id]) => group.providers.includes(id))
                  if (rows.length === 0) return null
                  return (
                    <section key={group.key} className="space-y-2">
                      <h3 className="text-xs font-medium text-muted-foreground">{group.label}</h3>
                      <div className="grid grid-cols-2 gap-2">
                        {rows.map(([id, label]) => (
                          <Button key={id} type="button" variant="outline" onClick={() => selectProvider(id)} className="h-12 justify-start gap-3 px-3">
                            <ChannelProviderIcon provider={id} className="size-5" />
                            <span className="truncate">{label}</span>
                          </Button>
                        ))}
                      </div>
                    </section>
                  )
                })}
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <Button type="button" variant="ghost" size="sm" onClick={() => setStep(1)} className="-ml-2 gap-1">
                  <ChevronLeft size={14} />重新选择供应商
                </Button>
                <div className="flex items-center gap-3 rounded-xl border p-3">
                  <ChannelProviderIcon provider={provider} className="size-7" />
                  <div><div className="font-medium">{PROVIDER_LABELS[provider]}</div><div className="text-xs text-muted-foreground">{provider}</div></div>
                </div>
                {OAUTH_PROVIDERS.has(provider) && !OAUTH_ONLY_PROVIDERS.has(provider) && (
                  <div className="space-y-2">
                    <Label>连接方式</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <Button type="button" variant={authMode === 'oauth' ? 'default' : 'outline'} onClick={() => setAuthMode('oauth')}>订阅账号</Button>
                      <Button type="button" variant={authMode === 'api-key' ? 'default' : 'outline'} onClick={() => setAuthMode('api-key')}>API Key</Button>
                    </div>
                  </div>
                )}
                <div className="space-y-2"><Label>连接名称</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></div>
                <div className="space-y-2"><Label>Base URL</Label><Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="font-mono text-xs" /></div>
                {provider === 'custom' && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>供应商标识</Label>
                      <Input
                        value={providerId}
                        onChange={(event) => setProviderId(event.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
                        placeholder="my-provider"
                        className="font-mono text-xs"
                      />
                      <p className="text-xs text-muted-foreground">用于稳定标识该供应商，例如 my-provider/model-id。</p>
                    </div>
                    <div className="space-y-2">
                      <Label>协议</Label>
                      <Select value={apiFamily === 'openai' ? `openai-${openaiApiMode}` : apiFamily} onValueChange={(value) => {
                        if (!value) return
                        if (value.startsWith('openai-')) { setApiFamily('openai'); setOpenaiApiMode(value.endsWith('responses') ? 'responses' : 'chat-completions') }
                        else setApiFamily(value as ProviderApiFamily)
                      }}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="openai-chat-completions">OpenAI Chat Completions</SelectItem>
                          <SelectItem value="openai-responses">OpenAI Responses</SelectItem>
                          <SelectItem value="anthropic">Anthropic Messages</SelectItem>
                          <SelectItem value="google">Google Gen AI</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
                {provider === 'openai' && (
                  <div className="space-y-2"><Label>协议</Label><Select value={openaiApiMode} onValueChange={(value) => setOpenaiApiMode(value as OpenAiApiMode)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="chat-completions">Chat Completions</SelectItem><SelectItem value="responses">Responses</SelectItem></SelectContent></Select></div>
                )}
                {authMode === 'api-key' && <div className="space-y-2"><Label>API Key</Label><Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." /></div>}
                {authMode === 'oauth' && <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">先创建本地连接，下一步会使用系统浏览器或设备码完成登录。</p>}
                {error && <p className="text-sm text-destructive">{error}</p>}
              </div>
            )}

            {step === 3 && created && (
              <div className="space-y-5">
                <div className="rounded-xl border p-4">
                  <div className="font-medium">{created.name}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {authMode === 'oauth' ? '连接配置已创建，登录完成后即可使用' : '连接已创建并直接启用'}
                  </div>
                </div>
                {authMode === 'oauth' && (
                  <div className="space-y-3 rounded-xl border p-4">
                    <div><div className="font-medium">登录订阅账号</div><p className="mt-1 text-xs text-muted-foreground">凭据会加密保存在本机保险库中。</p></div>
                    <ConnectionOAuthLogin connectionId={created.id} onCompleted={() => void syncModels(created.id)} />
                  </div>
                )}
                <div className="space-y-3 rounded-xl border p-4">
                  <div className="flex items-center justify-between gap-3"><div><div className="font-medium">模型目录</div><p className="mt-1 text-xs text-muted-foreground">同步发现的新模型会立即启用。</p></div>{syncing && <Loader2 size={16} className="animate-spin" />}</div>
                  {syncMessage && <p className="text-sm text-muted-foreground">{syncMessage}</p>}
                  <Button type="button" variant="outline" onClick={() => void syncModels()} disabled={syncing || (authMode === 'oauth' && created.authType !== 'oauth')}>重新同步</Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t bg-muted/30 px-6 py-4">
            {step === 2 && <Button type="button" onClick={() => void createConnection()} disabled={saving}>{saving && <Loader2 size={14} className="mr-2 animate-spin" />}创建并继续</Button>}
            {step === 3 && <Button type="button" onClick={() => onOpenChange(false)}>完成</Button>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
