import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAtom, useSetAtom } from "jotai";
import type {
  LinkConnectionSummary, LinkOAuthConfigSummary, LinkProviderDetail, LinkProviderSummary, LinkRuntimeMode,
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
import { cn } from "@/lib/utils";
import { LinkCatalog } from "./LinkCatalog";
import { LinkDetailPane } from "./LinkDetailPane";
import { LinkAccountConnectDialog } from "./LinkAccountConnectDialog";
import { LinkProviderSetupDialog } from "./LinkProviderSetupDialog";
import { canCreateLinkConnection, canStartLinkConnectionFlow, isLinkProviderVisible } from "./link-provider-availability";
import { resolveLinkOAuthSetupState } from "./link-provider-state";
import type { LinkFilter } from "./LinkToolbar";

const SETTINGS_TAB_ID = "__settings__";
const LINK_RUNTIME_SETTINGS_TAB = "link-runtime";

type LinkDialogState =
  | { kind: "account-connect"; connectionName: string; authType?: string; mode: "create" | "reconnect" }
  | { kind: "provider-setup"; connectionName: string; authType?: string; continueToAccount: boolean; mode: "create" | "reconnect" }
  | null;

export function LinkView() {
  const [providers, setProviders] = useState<LinkProviderSummary[]>([]);
  const [connections, setConnections] = useState<LinkConnectionSummary[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LinkFilter>("all");
  const [selected, setSelected] = useState<LinkProviderDetail | null>(null);
  const [dialog, setDialog] = useState<LinkDialogState>(null);
  const [online, setOnline] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<LinkRuntimeMode>("local");
  const [runtimeOrigin, setRuntimeOrigin] = useState<string | null>(null);
  const [oauthConfigs, setOAuthConfigs] = useState<LinkOAuthConfigSummary[]>([]);
  const [providerTarget, setProviderTarget] = useAtom(linkProviderTargetAtom);
  const [deleteTarget, setDeleteTarget] = useState<LinkConnectionSummary | null>(null);
  const setTabs = useSetAtom(tabsAtom);
  const setActiveTabId = useSetAtom(activeTabIdAtom);
  const setSettingsInitialTab = useSetAtom(settingsInitialTabAtom);

  const refresh = useCallback(async () => {
    const runtime = await getLinkRuntimeState();
    setRuntimeMode(runtime.mode);
    setRuntimeOrigin(runtime.origin);
    if (runtime.phase !== "online") {
      setOnline(false);
      setProviders([]); setConnections([]); setOAuthConfigs([]); return;
    }
    const [nextProviders, nextConnections, nextOAuthConfigs] = await Promise.all([
      listLinkProviders(), listLinkConnections(), listLinkOAuthConfigs(),
    ]);
    setProviders(nextProviders);
    setConnections(nextConnections);
    setOAuthConfigs(nextOAuthConfigs);
    setOnline(true);
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
    const target = providerTarget;
    const configured = connections.some((connection) => connection.service === target.service && connection.configured);
    setProviderTarget(null);
    if (!isLinkProviderVisible(target.service, runtimeMode, runtimeOrigin, configured)) {
      toast.error("当前运行时无法连接此服务，请配置公网可访问的已有部署后重试");
      return;
    }
    void getLinkProvider(target.service)
      .then((provider) => { setDialog(null); setSelected(provider); })
      .catch(() => toast.error("无法打开连接器详情"));
  }, [connections, online, providerTarget, runtimeMode, runtimeOrigin, setProviderTarget]);

  useEffect(() => {
    if (!selected) return;
    const configured = connections.some((connection) => connection.service === selected.service && connection.configured);
    if (isLinkProviderVisible(selected.service, runtimeMode, runtimeOrigin, configured)) return;
    setDialog(null);
    setSelected(null);
  }, [connections, runtimeMode, runtimeOrigin, selected]);

  const openProvider = (service: string) => {
    void getLinkProvider(service)
      .then((detail) => { setDialog(null); setSelected(detail); })
      .catch(() => toast.error("无法打开连接器详情"));
  };

  const openAccountDialog = (
    connectionName: string,
    authType?: string,
    mode: "create" | "reconnect" = "create",
  ) => {
    if (!selected) return;
    const selectedAuthType = authType ?? (selected.auth.length === 1 ? String(selected.auth[0]?.type) : undefined);
    if (!canStartLinkConnectionFlow(selected.service, runtimeMode, runtimeOrigin, mode, selectedAuthType)) {
      toast.error("当前运行时无法接收此服务的公网回调");
      return;
    }
    const oauthConfig = oauthConfigs.find((config) => config.service === selected.service);
    const authTypes = selected.authTypes?.length
      ? selected.authTypes
      : selected.auth.map((auth) => String(auth.type));
    const oauthSetup = resolveLinkOAuthSetupState(authTypes, oauthConfig?.configured ?? false);
    if (selectedAuthType === "oauth2" && oauthSetup !== "configured") {
      setDialog({ kind: "provider-setup", connectionName, authType: selectedAuthType, continueToAccount: true, mode });
      return;
    }
    setDialog({ kind: "account-connect", connectionName, authType: selectedAuthType, mode });
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
          连接器需要可用的 OpenConnector 服务。请在「设置 → Link 运行时」中启用本机服务或配置已有部署。
        </p>
        <Button variant="outline" onClick={openLinkRuntimeSettings}>
          打开 Link 运行时设置
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-[var(--lume-border-subtle)] px-4 py-2.5">
        <div>
          <h1 className="text-base font-semibold">连接器</h1>
          <p className="mt-0.5 text-xs text-[var(--text-3)]">连接常用应用与数据服务，并查看智能体可以调用的能力。</p>
        </div>
        <Badge variant="success">{runtimeMode === "remote" ? "已有部署运行中" : "本机服务运行中"}</Badge>
      </div>
      <div className={cn(
        "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden transition-[grid-template-columns] duration-200 ease-out",
        selected && "min-[960px]:grid-cols-[minmax(0,1fr)_minmax(24rem,min(46%,34rem))]",
      )}>
        <div className={cn(
          "min-h-0 overflow-hidden",
          selected && "hidden min-[960px]:block",
        )}>
          <LinkCatalog
            providers={providers}
            connections={connections}
            oauthConfigs={oauthConfigs}
            runtimeMode={runtimeMode}
            runtimeOrigin={runtimeOrigin}
            query={query}
            onQueryChange={setQuery}
            filter={filter}
            onFilterChange={setFilter}
            selectedService={selected?.service ?? null}
            onOpen={openProvider}
          />
        </div>
        {selected && (
          <aside className="min-h-0 min-w-0 overflow-y-auto border-l border-[var(--lume-border-subtle)] bg-background p-3 pt-4 animate-in fade-in-0 slide-in-from-right-2 max-[959px]:border-l-0">
            <LinkDetailPane
              provider={selected}
              connections={connections.filter((c) => c.service === selected.service)}
              oauthConfig={oauthConfigs.find((config) => config.service === selected.service)}
              runtimeMode={runtimeMode}
              canAddAccount={canCreateLinkConnection(selected.service, runtimeMode, runtimeOrigin)}
              onConnect={() => openAccountDialog(
                connections.some((connection) => connection.service === selected.service) ? "" : "default",
              )}
              onConfigureProvider={() => setDialog({
                kind: "provider-setup",
                connectionName: "default",
                continueToAccount: false,
                mode: "create",
              })}
              onClose={() => { setDialog(null); setSelected(null); }}
              onReconnect={(name) => {
                const connection = connections.find((item) => item.service === selected.service && item.connectionName === name);
                openAccountDialog(name, connection?.authType, "reconnect");
              }}
              onRequestDelete={(name) => {
                const target = connections.find((c) => c.service === selected.service && c.connectionName === name);
                if (target) setDeleteTarget(target);
              }}
            />
          </aside>
        )}
      </div>
      {selected && dialog?.kind === "account-connect" && (
        <LinkAccountConnectDialog
          provider={selected}
          initialConnectionName={dialog.connectionName}
          initialAuthType={dialog.authType}
          mode={dialog.mode}
          runtimeMode={runtimeMode}
          existingConnectionNames={connections
            .filter((connection) => connection.service === selected.service)
            .map((connection) => connection.connectionName)}
          oauthConfig={oauthConfigs.find((config) => config.service === selected.service)}
          onClose={() => setDialog(null)}
          onConfigureProvider={(connectionName, authType) => setDialog({
            kind: "provider-setup",
            connectionName,
            authType,
            continueToAccount: true,
            mode: dialog.mode,
          })}
          onSaved={async () => { await refresh(); setDialog(null); }}
        />
      )}
      {selected && dialog?.kind === "provider-setup" && (
        <LinkProviderSetupDialog
          provider={selected}
          oauthConfig={oauthConfigs.find((config) => config.service === selected.service)}
          runtimeMode={runtimeMode}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            await refresh();
            setDialog(dialog.continueToAccount
              ? { kind: "account-connect", connectionName: dialog.connectionName, authType: dialog.authType, mode: dialog.mode }
              : null);
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="断开这个连接？"
        description={deleteTarget ? `将删除 ${deleteTarget.service} 的 ${deleteTarget.connectionName} ${runtimeMode === "remote" ? "已有部署凭据" : "本机凭据"}。` : ""}
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
