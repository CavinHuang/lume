import { Button } from '@/components/ui/button'
"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, Plus } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { SkillCatalogItem } from "@lume/shared"
import { getSkillMarketCatalog, installSkillMarketItemToWorkspace, deleteWorkspaceSkill } from "@/lib/desktop-api"

export interface SkillAddSourceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceSlug: string | null
  /** 选择"手动创建"后的回调 */
  onCreateNew: () => void
  /** 选择"浏览市场"后的回调 */
  onOpenMarket: () => void
}

type TabKey = "market" | "built-in" | "create"

const TABS: { key: TabKey; label: string; description: string }[] = [
  {
    key: "market",
    label: "浏览市场",
    description: "从已订阅的市场源中浏览和安装技能",
  },
  {
    key: "built-in",
    label: "内置技能",
    description: "选择系统自带的内置技能直接启用",
  },
  {
    key: "create",
    label: "手动创建",
    description: "从空白编辑器开始，自定义编写技能",
  },
]

export function SkillAddSourceDialog({
  open,
  onOpenChange,
  workspaceSlug,
  onCreateNew,
  onOpenMarket,
}: SkillAddSourceDialogProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("market")
  const [items, setItems] = useState<SkillCatalogItem[]>([])
  const [loading, setLoading] = useState(false)
  const [installingSlug, setInstallingSlug] = useState<string | null>(null)
  const [removingSlug, setRemovingSlug] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installNotice, setInstallNotice] = useState<string | null>(null)

  // 当弹窗打开时，重置状态
  useEffect(() => {
    if (!open) return
    setActiveTab("market")
    setItems([])
    setInstallError(null)
    setInstallNotice(null)
    setInstallingSlug(null)
  }, [open])

  // 加载目录数据
  useEffect(() => {
    if (!open || activeTab === "create") return
    if (!workspaceSlug) {
      setItems([])
      setLoading(false)
      return
    }

    setLoading(true)
    setInstallError(null)
    setItems([])
    getSkillMarketCatalog(workspaceSlug)
      .then((catalog) => {
        if (activeTab === "market") {
          setItems(
            catalog.items.filter((item) => item.sourceType === "subscribed-market"),
          )
        } else {
          setItems(
            catalog.items.filter((item) => item.sourceType === "built-in"),
          )
        }
      })
      .catch((err) => {
        setInstallError(err instanceof Error ? err.message : String(err))
        setItems([])
      })
      .finally(() => setLoading(false))
  }, [open, activeTab, workspaceSlug])

  const handleInstall = useCallback(
    async (item: SkillCatalogItem) => {
      if (!workspaceSlug) return
      setInstallingSlug(item.slug)
      setInstallError(null)
      setInstallNotice(null)
      try {
        await installSkillMarketItemToWorkspace({
          workspaceSlug,
          skillId: item.id,
          overwrite: false,
        })
        setInstallNotice(`「${item.name}」安装成功`)
        // 安装成功后刷新列表
        const catalog = await getSkillMarketCatalog(workspaceSlug)
        if (activeTab === "market") {
          setItems(
            catalog.items.filter((i) => i.sourceType === "subscribed-market"),
          )
        } else {
          setItems(
            catalog.items.filter((i) => i.sourceType === "built-in"),
          )
        }
      } catch (err) {
        setInstallError(err instanceof Error ? err.message : String(err))
      } finally {
        setInstallingSlug(null)
      }
    },
    [workspaceSlug, activeTab],
  )

  const handleRemove = useCallback(
    async (item: SkillCatalogItem) => {
      if (!workspaceSlug) return
      setRemovingSlug(item.slug)
      setInstallError(null)
      setInstallNotice(null)
      try {
        await deleteWorkspaceSkill(workspaceSlug, item.slug)
        setInstallNotice(`「${item.name}」已移除`)
        // 刷新列表
        const catalog = await getSkillMarketCatalog(workspaceSlug)
        if (activeTab === "market") {
          setItems(
            catalog.items.filter((i) => i.sourceType === "subscribed-market"),
          )
        } else {
          setItems(
            catalog.items.filter((i) => i.sourceType === "built-in"),
          )
        }
      } catch (err) {
        setInstallError(err instanceof Error ? err.message : String(err))
      } finally {
        setRemovingSlug(null)
      }
    },
    [workspaceSlug, activeTab],
  )

  const handleTabChange = (tab: TabKey) => {
    setActiveTab(tab)
    setInstallError(null)
    setInstallNotice(null)
    setItems([])
  }

  const handleManualCreate = () => {
    onOpenChange(false)
    onCreateNew()
  }

  const handleOpenMarket = () => {
    onOpenChange(false)
    onOpenMarket()
  }

  const renderActionButton = (item: SkillCatalogItem) => {
    const isInstalling = installingSlug === item.slug
    const isRemoving = removingSlug === item.slug

    if (item.installState === "installed") {
      return (
        <Button
                variant="ghost"
          type="button"
          disabled={isRemoving || isInstalling}
          onClick={() => void handleRemove(item)}
          className="flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[12px] font-semibold text-[var(--text-2)] hover:border-[color:color-mix(in_oklab,var(--lume-danger)_42%,var(--border))] hover:text-[var(--lume-danger)] disabled:cursor-wait disabled:opacity-60"
        >
          {isRemoving && <Loader2 size={13} className="animate-spin" />}
          移除
        </Button>
      )
    }

    if (item.installState === "update-available") {
      return (
        <Button
                variant="ghost"
          type="button"
          disabled={isInstalling}
          onClick={() => void handleInstall(item)}
          className="flex h-8 items-center gap-1.5 rounded-[6px] bg-[var(--brand)] px-3 text-[12px] font-semibold text-[var(--brand-foreground)] hover:bg-[color:color-mix(in_oklab,var(--brand)_88%,var(--brand-2))] disabled:cursor-wait disabled:opacity-60"
        >
          {isInstalling && <Loader2 size={13} className="animate-spin" />}
          更新
        </Button>
      )
    }

    return (
      <Button
                variant="ghost"
        type="button"
        disabled={isInstalling}
        onClick={() => void handleInstall(item)}
        className="flex h-8 items-center gap-1.5 rounded-[6px] border border-[color:color-mix(in_oklab,var(--brand)_36%,var(--border-strong))] bg-[var(--surface-1)] px-3 text-[12px] font-semibold text-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] disabled:cursor-wait disabled:opacity-60"
      >
        {isInstalling && <Loader2 size={13} className="animate-spin" />}
        安装
      </Button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]" showCloseButton>
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold text-[var(--text-1)]">
            添加技能
          </DialogTitle>
        </DialogHeader>

        {/* Tab 切换 */}
        <div className="lume-segmented flex gap-1">
          {TABS.map((tab) => (
            <Button
                variant="ghost"
              key={tab.key}
              type="button"
              onClick={() => handleTabChange(tab.key)}
              className={cn(
                "lume-segmented-item flex-1 font-semibold",
                activeTab === tab.key
                  ? "lume-segmented-item-active"
                  : "",
              )}
            >
              {tab.label}
            </Button>
          ))}
        </div>

        {/* 描述 */}
        <p className="text-[13px] leading-5 text-[var(--text-2)]">
          {TABS.find((t) => t.key === activeTab)?.description}
        </p>

        {/* 内容区 */}
        <div className="lume-subpanel max-h-[360px] min-h-[120px] overflow-y-auto">
          {activeTab === "create" ? (
            <div className="flex flex-col items-center justify-center gap-3 p-8">
              <div className="flex size-12 items-center justify-center rounded-full bg-[var(--surface-1)]">
                <Plus size={22} className="text-[var(--text-2)]" />
              </div>
              <p className="text-[13px] text-[var(--text-2)]">
                从空白编辑器开始编写自定义技能
              </p>
              <Button
                variant="ghost"
                type="button"
                onClick={handleManualCreate}
                className="flex h-9 items-center gap-2 rounded-[8px] bg-[var(--brand)] px-4 text-[13px] font-semibold text-[var(--brand-foreground)] hover:bg-[color:color-mix(in_oklab,var(--brand)_88%,var(--brand-2))]"
              >
                <Plus size={15} />
                创建空白技能
              </Button>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-[13px] text-[var(--text-2)]">
              <Loader2 size={16} className="animate-spin" />
              正在加载...
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 p-8 text-[13px] text-[var(--text-2)]">
              {activeTab === "market"
                ? "当前没有已订阅的市场源，请先在市场页面添加市场源。"
                : "没有可用的内置技能。"}
              {activeTab === "market" && (
                <Button
                variant="ghost"
                  type="button"
                  onClick={handleOpenMarket}
                  className="text-[13px] font-semibold text-[var(--brand)] hover:text-[var(--brand-2)]"
                >
                  前往市场添加源
                </Button>
              )}
            </div>
          ) : (
            <div className="grid gap-1">
              {items.map((item) => (
                <div
                  key={item.slug}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--surface-1)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-[var(--text-1)]">
                      {item.name}
                    </div>
                    {item.description && (
                      <p className="mt-0.5 line-clamp-1 text-[12px] text-[var(--text-2)]">
                        {item.description}
                      </p>
                    )}
                  </div>
                  {renderActionButton(item)}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 通知/错误 */}
        {installNotice && (
          <p className="text-[13px] leading-5 text-[var(--lume-success)]">{installNotice}</p>
        )}
        {installError && (
          <p className="text-[13px] leading-5 text-[var(--lume-danger)]">{installError}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
