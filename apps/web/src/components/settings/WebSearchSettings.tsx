import * as React from 'react'
import { Check, Eye, EyeOff, Loader2, Save, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import type {
  LumeConfigWebSearchSection,
  LumeEffectiveConfig,
  WebSearchProvider,
  WebSearchStrategy,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { getEffectiveLumeConfig, updateWebSearchConfig } from '@/lib/desktop-api/lume-config'
import { testSearchBackend } from '@/lib/desktop-api/system'

import { Input } from '@/components/ui/input'
interface ProviderMeta {
  id: WebSearchProvider
  label: string
  description: string
  needsApiKey: boolean
  apiKeyPlaceholder?: string
  link: string
  linkLabel: string
  badge?: string
}

const GUANLAN_PROVIDER: ProviderMeta = {
  id: 'guanlan',
  label: '观澜 / Guanlan',
  description: '基于第三方开源项目「观澜 Guanlan」，Alice 启动时自动安装，无需配置。',
  needsApiKey: false,
  link: 'https://github.com/shenyangs/Guanlan',
  linkLabel: 'github.com/shenyangs/Guanlan →',
  badge: '第三方',
}

const GUANLAN_BADGES = ['第三方', '免费', '无需 Key']
const GUANLAN_CAPABILITIES = [
  {
    name: 'guanlan_search',
    description: '中文搜索 — Baidu/Bing/DDG 多后端聚合，信源路由与分类',
  },
  {
    name: 'guanlan_read',
    description: '网页阅读 — Jina Reader + 直连 HTML 降级链，中文网页质量检测',
  },
  {
    name: 'guanlan_hotnews',
    description: '中文热榜 — 百度/微博/B站/IT之家/V2EX 多源聚合',
  },
  {
    name: 'guanlan_research',
    description: '研究证据包 — 自动路由信源、拆分查询、多角色搜索',
  },
]

const SEARCH_PROVIDERS: ProviderMeta[] = [
  {
    id: 'exa',
    label: 'Exa Search',
    description: '专为 AI Agent 设计的语义搜索，质量最高',
    needsApiKey: true,
    apiKeyPlaceholder: 'exa-...',
    link: 'https://dashboard.exa.ai/api-keys',
    linkLabel: 'dashboard.exa.ai →',
    badge: '推荐',
  },
  {
    id: 'pipellm',
    label: 'PipeLLM WebSearch',
    description: '国内网络友好，稳定性好',
    needsApiKey: true,
    apiKeyPlaceholder: 'pipe-...',
    link: 'https://console.pipellm.ai/keys',
    linkLabel: 'console.pipellm.ai →',
  },
  {
    id: 'zhipu',
    label: 'Zhipu Web Search',
    description: '智谱 AI 原生搜索，意图识别增强，国内稳定',
    needsApiKey: true,
    apiKeyPlaceholder: '输入智谱 API Key',
    link: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    linkLabel: 'bigmodel.cn →',
    badge: '国内',
  },
  {
    id: 'tavily',
    label: 'Tavily Search',
    description: 'AI 原生搜索引擎，支持深度搜索',
    needsApiKey: true,
    apiKeyPlaceholder: 'tvly-...',
    link: 'https://app.tavily.com/home',
    linkLabel: 'app.tavily.com →',
  },
  {
    id: 'brave',
    label: 'Brave Search',
    description: '注重隐私的独立搜索引擎，API 免费额度充足',
    needsApiKey: true,
    apiKeyPlaceholder: 'BSA...',
    link: 'https://brave.com/search/api/',
    linkLabel: 'brave.com/search/api →',
  },
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    description: '无需 API Key，免费可用的隐私搜索引擎',
    needsApiKey: false,
    link: 'https://duckduckgo.com/',
    linkLabel: 'duckduckgo.com →',
  },
]

const PROVIDERS: ProviderMeta[] = [GUANLAN_PROVIDER, ...SEARCH_PROVIDERS]

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail' | 'empty'

interface ProviderDraft {
  enabled: boolean
  apiKey: string
  hasExistingKey: boolean
}

type DraftMap = Record<WebSearchProvider, ProviderDraft>

const STRATEGY_OPTIONS: Array<{ value: WebSearchStrategy; label: string; desc: string }> = [
  { value: 'priority', label: '优先级模式', desc: '按顺序依次尝试已启用的后端，首个可用即返回' },
  { value: 'joint', label: '联合搜索', desc: '同时查询多个已启用后端，合并去重后返回' },
]

export function WebSearchSettings() {
  const [strategy, setStrategy] = React.useState<WebSearchStrategy>('priority')
  const [drafts, setDrafts] = React.useState<DraftMap>(() => buildInitialDrafts())
  const [loading, setLoading] = React.useState(true)
  const [testStatuses, setTestStatuses] = React.useState<Record<string, TestStatus>>({})
  const [savingKey, setSavingKey] = React.useState<string | null>(null)
  const [visibleKeys, setVisibleKeys] = React.useState<Set<WebSearchProvider>>(new Set())
  const savedRef = React.useRef<string | null>(null)
  const testTimers = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  React.useEffect(() => {
    let cancelled = false
    getEffectiveLumeConfig()
      .then((config) => {
        if (cancelled) return
        applyConfig(config, setDrafts, setStrategy, setSavingKey)
      })
      .catch((error) => {
        console.error('[WebSearchSettings] load FAILED:', error)
        toast.error('加载网络搜索设置失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const updateDraft = (provider: WebSearchProvider, patch: Partial<ProviderDraft>) => {
    setDrafts((current) => ({
      ...current,
      [provider]: { ...current[provider], ...patch },
    }))
  }

  const toggleKeyVisibility = (provider: WebSearchProvider) => {
    setVisibleKeys((current) => {
      const next = new Set(current)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }

  const handleToggleProvider = async (provider: WebSearchProvider, enabled: boolean) => {
    updateDraft(provider, { enabled })
    const config = await getEffectiveLumeConfig()
    const currentProviders = config.webSearch?.providers ?? {}
    const nextProviders: LumeConfigWebSearchSection['providers'] = {
      ...currentProviders,
      [provider]: {
        ...currentProviders[provider],
        enabled,
      },
    }
    await updateWebSearchConfig({ strategy, providers: nextProviders })
  }

  const handleSaveKey = async (provider: WebSearchProvider) => {
    const draft = drafts[provider]
    const keyId = `key_${provider}`
    setSavingKey(keyId)
    try {
      const config = await getEffectiveLumeConfig()
      const currentProviders = config.webSearch?.providers ?? {}
      const nextProviders: LumeConfigWebSearchSection['providers'] = {
        ...currentProviders,
        [provider]: {
          enabled: draft.enabled,
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        },
      }
      const nextConfig = await updateWebSearchConfig({ strategy, providers: nextProviders })
      applyConfig(nextConfig, setDrafts, setStrategy, setSavingKey)
      savedRef.current = keyId
      setTimeout(() => { savedRef.current = null }, 2000)
      toast.success(`${PROVIDERS.find((p) => p.id === provider)?.label ?? provider} Key 已保存`)
    } catch (error) {
      console.error('[WebSearchSettings] save key FAILED:', error)
      toast.error('保存 Key 失败')
    } finally {
      setSavingKey(null)
    }
  }

  const handleTestBackend = async (provider: WebSearchProvider) => {
    const draft = drafts[provider]
    const meta = PROVIDERS.find((p) => p.id === provider)
    const apiKey = meta?.needsApiKey ? (draft.apiKey || (draft.hasExistingKey ? '__saved__' : '')) : undefined

    if (meta?.needsApiKey && !apiKey) {
      setTestStatuses((current) => ({ ...current, [provider]: 'empty' }))
      clearTestStatus(provider, 4000)
      return
    }

    setTestStatuses((current) => ({ ...current, [provider]: 'testing' }))
    try {
      const result = await testSearchBackend({
        provider,
        apiKey: apiKey === '__saved__' ? undefined : apiKey,
      })
      setTestStatuses((current) => ({ ...current, [provider]: result.ok ? 'ok' : 'fail' }))
    } catch {
      setTestStatuses((current) => ({ ...current, [provider]: 'fail' }))
    }
    clearTestStatus(provider, 4000)
  }

  const handleTestBackendById = async (provider: WebSearchProvider) => {
    setTestStatuses((current) => ({ ...current, [provider]: 'testing' }))
    try {
      const result = await testSearchBackend({ provider })
      setTestStatuses((current) => ({ ...current, [provider]: result.ok ? 'ok' : 'fail' }))
    } catch {
      setTestStatuses((current) => ({ ...current, [provider]: 'fail' }))
    }
    clearTestStatus(provider, 4000)
  }

  const handleSaveStrategy = async (value: WebSearchStrategy) => {
    setStrategy(value)
    try {
      const config = await getEffectiveLumeConfig()
      const currentProviders = config.webSearch?.providers ?? {}
      await updateWebSearchConfig({ strategy: value, providers: currentProviders })
    } catch (error) {
      console.error('[WebSearchSettings] save strategy FAILED:', error)
    }
  }

  function clearTestStatus(provider: string, delay: number) {
    if (testTimers.current[provider]) clearTimeout(testTimers.current[provider])
    testTimers.current[provider] = setTimeout(() => {
      setTestStatuses((current) => {
        const next = { ...current }
        delete next[provider]
        return next
      })
    }, delay)
  }

  if (loading) {
    return (
      <div className="lume-panel flex h-[280px] items-center justify-center text-[13px] text-[var(--text-3)]">
        <Loader2 size={14} className="mr-2 animate-spin" />
        加载网络搜索设置...
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <SettingsCard title="搜索策略" description="控制多搜索引擎的协作方式。">
        <div className="flex gap-3">
          {STRATEGY_OPTIONS.map((option) => {
            const selected = strategy === option.value
            return (
              <Button
                variant="ghost"
                key={option.value}
                type="button"
                onClick={() => void handleSaveStrategy(option.value)}
                className={cn(
                  'lume-subpanel flex-1 px-4 py-3 text-left transition-all',
                  selected
                    ? 'border-[color-mix(in_oklab,var(--brand)_30%,transparent)] bg-[color-mix(in_oklab,var(--brand)_8%,var(--surface-1))]'
                    : 'hover:bg-[var(--surface-1)]'
                )}
              >
                <div className="mb-0.5 flex items-center gap-2">
                  <span
                    className={cn(
                      'flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full border-2',
                      selected ? 'border-[var(--brand)]' : 'border-[var(--text-3)]'
                    )}
                  >
                    {selected && <span className="h-[5px] w-[5px] rounded-full bg-[var(--brand)]" />}
                  </span>
                  <p className={cn('text-[13px] font-medium', selected ? 'text-[var(--brand)]' : 'text-[var(--text-1)]')}>
                    {option.label}
                  </p>
                </div>
                <p className="ml-[22px] text-[11px] leading-[18px] text-[var(--text-3)]">{option.desc}</p>
              </Button>
            )
          })}
        </div>
      </SettingsCard>

      <SettingsCard title="搜索引擎" description="配置启用的搜索后端，按列表顺序决定优先级。">
        <div className="space-y-3">
          {SEARCH_PROVIDERS.map((meta, index) => {
            const draft = drafts[meta.id]
            const testStatus = testStatuses[meta.id] ?? 'idle'
            const hasKey = !meta.needsApiKey || !!draft.apiKey || draft.hasExistingKey
            const isSavingThisKey = savingKey === `key_${meta.id}`
            const justSaved = savedRef.current === `key_${meta.id}`
            const showKey = visibleKeys.has(meta.id)

            return (
              <div
                key={meta.id}
                className={cn(
                  'lume-subpanel p-4 transition-opacity',
                  draft.enabled ? '' : 'opacity-50'
                )}
              >
                <div className="mb-3 flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                          draft.enabled && hasKey
                            ? 'bg-[var(--brand)] text-[var(--brand-foreground)]'
                            : 'bg-[var(--border)] text-[var(--text-3)]'
                        )}
                      >
                        {index + 1}
                      </span>
                      <p className="text-[14px] font-medium text-[var(--text-1)]">{meta.label}</p>
                      {meta.badge && (
                        <span className="rounded-[4px] bg-[color-mix(in_oklab,var(--brand)_12%,var(--surface-1))] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--brand)]">
                          {meta.badge}
                        </span>
                      )}
                      {meta.needsApiKey && hasKey && (
                        <span className="rounded-full bg-[color-mix(in_oklab,var(--brand)_10%,transparent)] px-2 py-0.5 text-[10px] font-medium text-[var(--brand)]">
                          已配置
                        </span>
                      )}
                    </div>
                    <p className="mt-1 ml-7 text-[12px] leading-4 text-[var(--text-3)]">{meta.description}</p>
                    <a
                      href={meta.link}
                      className="ml-7 mt-0.5 block text-[12px] font-mono text-[var(--brand)] hover:underline"
                      onClick={(e) => {
                        e.preventDefault()
                        window.open(meta.link, '_blank')
                      }}
                    >
                      {meta.linkLabel}
                    </a>
                  </div>
                  <Switch
                    checked={draft.enabled}
                    onCheckedChange={(checked) => void handleToggleProvider(meta.id, checked)}
                    className="ml-3 mt-0.5 shrink-0"
                  />
                </div>

                {meta.needsApiKey ? (
                  <div className="flex gap-2">
                    <div className="relative min-w-0 flex-1">
                      <Input
                        type={showKey ? 'text' : 'password'}
                        value={draft.apiKey}
                        onChange={(e) => updateDraft(meta.id, { apiKey: e.target.value })}
                        placeholder={draft.hasExistingKey ? '留空保留已有 Key' : meta.apiKeyPlaceholder}
                        className="h-9 w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 pr-9 font-mono text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
                      />
                      <Button
                variant="ghost"
                        type="button"
                        onClick={() => toggleKeyVisibility(meta.id)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)] hover:text-[var(--text-2)]"
                        tabIndex={-1}
                      >
                        {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </Button>
                    </div>
                    <Button
                variant="ghost"
                      type="button"
                      className={cn(
                        'h-9 shrink-0 rounded-[10px] px-3 text-[13px] font-medium',
                        justSaved ? 'bg-green-600 text-white' : ''
                      )}
                      disabled={isSavingThisKey}
                      onClick={() => void handleSaveKey(meta.id)}
                    >
                      {isSavingThisKey ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : justSaved ? (
                        <Check size={13} />
                      ) : (
                        <Save size={13} />
                      )}
                      {isSavingThisKey ? '保存中...' : justSaved ? '已保存' : '保存'}
                    </Button>
                    <TestButton status={testStatus} onClick={() => void handleTestBackend(meta.id)} hasKey={hasKey} />
                  </div>
                ) : (
                  <div>
                    <TestButton status={testStatus} onClick={() => void handleTestBackendById(meta.id)} hasKey />
                  </div>
                )}
              </div>
            )
          })}

          {/* Bing fallback */}
          <div className="lume-subpanel p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--border)] text-[11px] font-bold text-[var(--text-3)]">
                  {SEARCH_PROVIDERS.length + 1}
                </span>
                <div>
                  <p className="text-[14px] font-medium text-[var(--text-1)]">
                    Bing <span className="ml-1 text-[12px] font-normal text-[var(--text-3)]">免费后备</span>
                  </p>
                  <p className="text-[12px] text-[var(--text-3)]">
                    无需 Key，直接解析 Bing 搜索页面，当所有已配置后端均不可用时自动生效
                  </p>
                </div>
              </div>
              <TestButton
                status={testStatuses.bing ?? 'idle'}
                onClick={() => void handleTestBackendById('bing')}
                hasKey
              />
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="中文互联网搜索增强" description={GUANLAN_PROVIDER.description}>
        {(() => {
          const meta = GUANLAN_PROVIDER
          const draft = drafts[meta.id]

          return (
            <div
              className={cn(
                'lume-subpanel p-5 transition-opacity',
                draft.enabled ? '' : 'opacity-50'
              )}
            >
              <div className="flex items-start gap-4">
                <div className="mt-1 hidden h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[color-mix(in_oklab,var(--brand)_16%,var(--surface-1))] text-[var(--brand)] sm:flex">
                  <Search size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-wrap items-center gap-3">
                      <p className="text-[15px] font-semibold text-[var(--text-1)]">{meta.label}</p>
                      {GUANLAN_BADGES.map((badge) => (
                        <span
                          key={badge}
                          className={cn(
                            'rounded-[6px] px-2 py-0.5 text-[12px] font-semibold',
                            badge === '第三方'
                              ? 'bg-orange-500/10 text-orange-500'
                              : badge === '免费'
                                ? 'bg-[color:color-mix(in_oklab,var(--lume-success)_10%,var(--surface-1))] text-[var(--lume-success)]'
                                : 'bg-[color-mix(in_oklab,var(--brand)_12%,var(--surface-1))] text-[var(--brand)]'
                          )}
                        >
                          {badge}
                        </span>
                      ))}
                    </div>
                    <Switch
                      checked={draft.enabled}
                      onCheckedChange={(checked) => void handleToggleProvider(meta.id, checked)}
                      className="mt-0.5 shrink-0"
                    />
                  </div>
                  <p className="mt-2 text-[13px] leading-6 text-[var(--text-3)]">
                    观澜是一个开源的中文互联网研究工具（MIT License），让 AI Agent 看懂中文互联网。Alice 内置了以下能力：
                  </p>
                  <ul className="mt-3 space-y-2 text-[13px] leading-5 text-[var(--text-3)]">
                    {GUANLAN_CAPABILITIES.map((item) => (
                      <li key={item.name} className="flex gap-3">
                        <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--text-2)]" />
                        <span>
                          <code className="rounded-[4px] bg-[color-mix(in_oklab,var(--brand)_8%,transparent)] px-1 py-0.5 font-mono text-[13px] text-[var(--text-1)]">
                            {item.name}
                          </code>
                          <span className="ml-2">{item.description}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-3">
                    <a
                      href={meta.link}
                      className="font-mono text-[13px] text-[var(--text-1)] hover:text-[var(--brand)] hover:underline"
                      onClick={(e) => {
                        e.preventDefault()
                        window.open(meta.link, '_blank')
                      }}
                    >
                      {meta.linkLabel}
                    </a>
                    <span className="text-[13px] text-[var(--text-3)]">MIT License</span>
                  </div>
                </div>
              </div>
            </div>
          )
        })()}
      </SettingsCard>
    </div>
  )
}

function TestButton({ status, onClick, hasKey }: { status: TestStatus; onClick: () => void; hasKey: boolean }) {
  return (
    <Button
                variant="ghost"
      type="button"
      onClick={onClick}
      disabled={status === 'testing'}
      title={hasKey ? '发送真实请求验证 Key 是否可用' : '请先填写并保存 Key'}
      className={cn(
        'h-9 shrink-0 rounded-[10px] border px-3 text-[13px] font-medium transition-all disabled:opacity-50',
        status === 'ok'
          ? 'border-[color:color-mix(in_oklab,var(--lume-success)_45%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-success)_7%,var(--surface-1))] text-[var(--lume-success)]'
          : status === 'fail' || status === 'empty'
            ? 'border-[color:color-mix(in_oklab,var(--lume-danger)_45%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-danger)_7%,var(--surface-1))] text-[var(--lume-danger)]'
            : 'border-[var(--border)] text-[var(--text-3)] hover:bg-[var(--surface-1)] hover:text-[var(--text-1)]'
      )}
    >
      {status === 'testing' ? (
        <span className="flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> 测试中
        </span>
      ) : status === 'ok' ? (
        <span className="flex items-center gap-1.5">
          <Check size={12} /> 连接成功
        </span>
      ) : status === 'fail' ? (
        <span className="flex items-center gap-1.5">
          <X size={12} /> 连接失败
        </span>
      ) : status === 'empty' ? (
        '请先填写 Key'
      ) : (
        '测试'
      )}
    </Button>
  )
}

function SettingsCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="lume-panel-padded">
      <div className="mb-4">
        <h3 className="text-[16px] font-semibold text-[var(--text-1)]">{title}</h3>
        {description && <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function buildInitialDrafts(): DraftMap {
  const drafts: Partial<DraftMap> = {}
  for (const meta of PROVIDERS) {
    const enabledByDefault = meta.id === 'guanlan' ? false : !meta.needsApiKey
    drafts[meta.id] = { enabled: enabledByDefault, apiKey: '', hasExistingKey: false }
  }
  return drafts as DraftMap
}

function applyConfig(
  config: LumeEffectiveConfig,
  setDrafts: React.Dispatch<React.SetStateAction<DraftMap>>,
  setStrategy: React.Dispatch<React.SetStateAction<WebSearchStrategy>>,
  setSavingKey: React.Dispatch<React.SetStateAction<string | null>>
) {
  const section = config.webSearch
  if (section?.strategy) setStrategy(section.strategy)
  setSavingKey(null)
  setDrafts(() => {
    const next: Partial<DraftMap> = {}
    for (const meta of PROVIDERS) {
      const entry = section?.providers?.[meta.id]
      const enabledByDefault = meta.id === 'guanlan' ? false : !meta.needsApiKey
      next[meta.id] = {
        enabled: entry?.enabled ?? enabledByDefault,
        apiKey: '',
        hasExistingKey: !!entry?.apiKey,
      }
    }
    return next as DraftMap
  })
}
