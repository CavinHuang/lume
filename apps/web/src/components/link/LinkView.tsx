import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAtom, useSetAtom } from "jotai";
import type {
  LinkConnectionSummary, LinkOAuthConfigSummary, LinkProviderDetail, LinkProviderSummary,
} from "@lume/shared";
import {
  activeTabIdAtom,
  linkProviderTargetAtom,
  settingsInitialTabAtom,
  tabsAtom,
} from "@/atoms";
import {
  deleteLinkConnection, getLinkProvider, getLinkRuntimeState, listLinkConnections,
  listLinkOAuthConfigs, listLinkProviders, onLinkDataChanged, onLinkRuntimeState,
} from "@/lib/desktop-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LinkCatalog } from "./LinkCatalog";
import { LinkDetailPane } from "./LinkDetailPane";
import { LinkConnectDialog } from "./LinkConnectDialog";
import type { LinkFilter } from "./LinkToolbar";

const SETTINGS_TAB_ID = "__settings__";
const LINK_RUNTIME_SETTINGS_TAB = "link-runtime";

export function LinkView() {
  const [providers, setProviders] = useState<LinkProviderSummary[]>([]);
  const [connections, setConnections] = useState<LinkConnectionSummary[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LinkFilter>("all");
  const [selected, setSelected] = useState<LinkProviderDetail | null>(null);
  // selected 控制右侧详情面板；connectOpen 独立控制凭据/OAuth 弹窗（点"连接"才开，与面板解耦）
  const [connectOpen, setConnectOpen] = useState(false);
  const [selectedConnectionName, setSelectedConnectionName] = useState("default");
  const [online, setOnline] = useState(false);
  const [oauthConfigs, setOAuthConfigs] = useState<LinkOAuthConfigSummary[]>([]);
  const [providerTarget, setProviderTarget] = useAtom(linkProviderTargetAtom);
  const [deleteTarget, setDeleteTarget] = useState<LinkConnectionSummary | null>(null);
  const setTabs = useSetAtom(tabsAtom);
  const setActiveTabId = useSetAtom(activeTabIdAtom);
  const setSettingsInitialTab = useSetAtom(settingsInitialTabAtom);

  const refresh = useCallback(async () => {
    const runtime = await getLinkRuntimeState();
    setOnline(runtime.phase === "online");
    if (runtime.phase !== "online") {
      setProviders([]); setConnections([]); setOAuthConfigs([]); return;
    }
    const [nextProviders, nextConnections, nextOAuthConfigs] = await Promise.all([
      listLinkProviders(), listLinkConnections(), listLinkOAuthConfigs(),
    ]);
    setProviders(nextProviders);
    setConnections(nextConnections);
    setOAuthConfigs(nextOAuthConfigs);
  }, []);

  useEffect(() => {
    void refresh().catch(() => toast.error("无法读取连接器数据"));
    let offRuntime: (() => void) | undefined;
    let offData: (() => void) | undefined;
    void onLinkRuntimeState(() => void refresh()).then((off) => { offRuntime = off; });
    void onLinkDataChanged(() => void refresh()).then((off) => { offData = off; });
    return () => { offRuntime?.(); offData?.(); };
  }, [refresh]);

  useEffect(() => {
    if (!online || !providerTarget) return;
    void getLinkProvider(providerTarget)
      .then((provider) => { setSelectedConnectionName("default"); setSelected(provider); setProviderTarget(null); })
      .catch(() => toast.error("无法打开连接器详情"));
  }, [online, providerTarget, setProviderTarget]);

  const openProvider = (service: string) => {
    void getLinkProvider(service)
      .then((detail) => { setSelectedConnectionName("default"); setSelected(detail); })
      .catch(() => toast.error("无法打开连接器详情"));
  };

  // 对齐 link-result.tsx/BrowserShell 的标准入口：atoms 驱动 tab 切换，settingsInitialTab 定位到 link-runtime
  const openLinkRuntimeSettings = () => {
    setSettingsInitialTab(LINK_RUNTIME_SETTINGS_TAB);
    setTabs((tabs) =>
      tabs.some((tab) => tab.id === SETTINGS_TAB_ID)
        ? tabs
        : [...tabs, { id: SETTINGS_TAB_ID, type: "settings", title: "设置" }],
    );
    setActiveTabId(SETTINGS_TAB_ID);
  };

  if (!online) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <Badge variant="secondary">未启用</Badge>
        <h1 className="text-xl font-semibold">连接器</h1>
        <p className="max-w-sm text-sm text-[var(--text-3)]">
          连接器需要本机 OpenConnector Link 运行时。请在「设置 → Link 运行时」中启用。
        </p>
        <Button variant="outline" onClick={openLinkRuntimeSettings}>
          打开 Link 运行时设置
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-center justify-between px-6 pt-6">
        <div>
          <h1 className="text-xl font-semibold">连接器</h1>
          <p className="mt-1 text-sm text-[var(--text-3)]">由本机 OpenConnector Link 提供，连接凭据不会进入渲染器。</p>
        </div>
        <Badge variant={online ? "default" : "secondary"}>{online ? "本地运行中" : "未启用"}</Badge>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] px-6 pb-6 transition-[grid-template-columns] duration-200 ease-out"
           style={selected ? { gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)" } : undefined}>
        <div className="min-h-0 overflow-hidden rounded-xl border border-[var(--lume-border-subtle)] bg-card">
          <LinkCatalog
            providers={providers}
            connections={connections}
            query={query}
            onQueryChange={setQuery}
            filter={filter}
            onFilterChange={setFilter}
            selectedService={selected?.service ?? null}
            onOpen={openProvider}
          />
        </div>
        {selected && (
          <div className="min-h-0 overflow-hidden rounded-xl border border-[var(--lume-border-subtle)] bg-card animate-in fade-in-0 slide-in-from-right-2">
            <LinkDetailPane
              provider={selected}
              connections={connections.filter((c) => c.service === selected.service)}
              oauthConfig={oauthConfigs.find((o) => o.service === selected.service)}
              onConnect={() => setConnectOpen(true)}
              onClose={() => setSelected(null)}
              onReconnect={(name) => { setSelectedConnectionName(name); setConnectOpen(true); }}
              onRequestDelete={(name) => {
                const target = connections.find((c) => c.service === selected.service && c.connectionName === name);
                if (target) setDeleteTarget(target);
              }}
            />
          </div>
        )}
      </div>
      {selected && connectOpen && (
        <LinkConnectDialog
          provider={selected}
          initialConnectionName={selectedConnectionName}
          oauthConfig={oauthConfigs.find((o) => o.service === selected.service)}
          connections={connections.filter((c) => c.service === selected.service)}
          onClose={() => setConnectOpen(false)}
          onSaved={async () => { await refresh(); setConnectOpen(false); }}
          onReconnect={(name) => setSelectedConnectionName(name)}
          onRequestDelete={(name) => {
            const target = connections.find((c) => c.service === selected.service && c.connectionName === name);
            if (target) setDeleteTarget(target);
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="断开这个连接？"
        description={deleteTarget ? `将删除 ${deleteTarget.service} 的 ${deleteTarget.connectionName} 本地凭据。` : ""}
        confirmLabel="断开连接"
        destructive
        onConfirm={() => {
          if (!deleteTarget) return;
          void deleteLinkConnection(deleteTarget.service, deleteTarget.connectionName)
            .then(() => refresh())
            .catch((error) => toast.error(error instanceof Error ? error.message : "断开失败"))
            .finally(() => setDeleteTarget(null));
        }}
      />
    </div>
  );
}
