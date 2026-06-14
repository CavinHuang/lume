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
        <button
          type="button"
          disabled={isRemoving || isInstalling}
          onClick={() => void handleRemove(item)}
          className="flex h-8 items-center gap-1.5 rounded-[6px] border border-[#d8ddec] bg-white px-3 text-[12px] font-semibold text-[#687196] hover:border-[#ba3636] hover:text-[#ba3636] disabled:cursor-wait disabled:opacity-60"
        >
          {isRemoving && <Loader2 size={13} className="animate-spin" />}
          移除
        </button>
      )
    }

    if (item.installState === "update-available") {
      return (
        <button
          type="button"
          disabled={isInstalling}
          onClick={() => void handleInstall(item)}
          className="flex h-8 items-center gap-1.5 rounded-[6px] bg-[#4f46e5] px-3 text-[12px] font-semibold text-white hover:bg-[#3730a3] disabled:cursor-wait disabled:opacity-60"
        >
          {isInstalling && <Loader2 size={13} className="animate-spin" />}
          更新
        </button>
      )
    }

    return (
      <button
        type="button"
        disabled={isInstalling}
        onClick={() => void handleInstall(item)}
        className="flex h-8 items-center gap-1.5 rounded-[6px] border border-[#4f46e5] bg-white px-3 text-[12px] font-semibold text-[#4f46e5] hover:bg-[#f5f6ff] disabled:cursor-wait disabled:opacity-60"
      >
        {isInstalling && <Loader2 size={13} className="animate-spin" />}
        安装
      </button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]" showCloseButton>
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold text-[#20232d]">
            添加技能
          </DialogTitle>
        </DialogHeader>

        {/* Tab 切换 */}
        <div className="flex gap-1 rounded-[8px] border border-[#e4e7f1] bg-[#f7f8fb] p-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => handleTabChange(tab.key)}
              className={cn(
                "flex-1 rounded-[6px] px-3 py-2 text-[13px] font-semibold transition-colors",
                activeTab === tab.key
                  ? "bg-white text-[#20232d] shadow-[0_8px_18px_-16px_rgba(43,52,103,0.54)]"
                  : "text-[#687196] hover:text-[#20232d]",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* 描述 */}
        <p className="text-[13px] leading-5 text-[#687196]">
          {TABS.find((t) => t.key === activeTab)?.description}
        </p>

        {/* 内容区 */}
        <div className="max-h-[360px] min-h-[120px] overflow-y-auto rounded-[8px] border border-[#e4e7f1]">
          {activeTab === "create" ? (
            <div className="flex flex-col items-center justify-center gap-3 p-8">
              <div className="flex size-12 items-center justify-center rounded-full bg-[#f0f0f0]">
                <Plus size={22} className="text-[#687196]" />
              </div>
              <p className="text-[13px] text-[#687196]">
                从空白编辑器开始编写自定义技能
              </p>
              <button
                type="button"
                onClick={handleManualCreate}
                className="flex h-9 items-center gap-2 rounded-[8px] bg-[#2f2f31] px-4 text-[13px] font-semibold text-white hover:bg-[#1f2023]"
              >
                <Plus size={15} />
                创建空白技能
              </button>
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-[13px] text-[#626b8f]">
              <Loader2 size={16} className="animate-spin" />
              正在加载...
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 p-8 text-[13px] text-[#687196]">
              {activeTab === "market"
                ? "当前没有已订阅的市场源，请先在市场页面添加市场源。"
                : "没有可用的内置技能。"}
              {activeTab === "market" && (
                <button
                  type="button"
                  onClick={handleOpenMarket}
                  className="text-[13px] font-semibold text-[#4f46e5] hover:text-[#3730a3]"
                >
                  前往市场添加源
                </button>
              )}
            </div>
          ) : (
            <div className="grid gap-1">
              {items.map((item) => (
                <div
                  key={item.slug}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[#f7f8fb]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-[#20232d]">
                      {item.name}
                    </div>
                    {item.description && (
                      <p className="mt-0.5 line-clamp-1 text-[12px] text-[#687196]">
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
          <p className="text-[13px] leading-5 text-[#4c7a41]">{installNotice}</p>
        )}
        {installError && (
          <p className="text-[13px] leading-5 text-[#ba3636]">{installError}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
