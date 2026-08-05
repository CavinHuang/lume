import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  LinkConnectionSummary,
  LinkCredentialField,
  LinkOAuthConfigSummary,
  LinkOAuthSession,
  LinkProviderDetail,
  LinkProviderSummary,
  LinkRunDetail,
  LinkRunSummary,
} from "@lume/shared";
import { toast } from "sonner";
import { useAtom } from "jotai";
import { linkProviderTargetAtom } from "@/atoms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  deleteLinkConnection,
  getLinkProvider,
  getLinkRun,
  getLinkRuntimeState,
  listLinkConnections,
  listLinkOAuthConfigs,
  listLinkProviders,
  listLinkRuns,
  openExternal,
  saveLinkOAuthConfig,
  startLinkOAuth,
  getLinkOAuthStatus,
  cancelLinkOAuth,
  upsertLinkConnection,
  onLinkDataChanged,
  onLinkRuntimeState,
  listLinkOAuthSessions,
  getLinkAction,
} from "@/lib/desktop-api";

export function LinkView() {
  const [providers, setProviders] = useState<LinkProviderSummary[]>([]);
  const [connections, setConnections] = useState<LinkConnectionSummary[]>([]);
  const [runs, setRuns] = useState<LinkRunSummary[]>([]);
  const [runCursor, setRunCursor] = useState<string | undefined>();
  const [runService, setRunService] = useState("");
  const [runOutcome, setRunOutcome] = useState("all");
  const [runBusy, setRunBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [connectionState, setConnectionState] = useState("all");
  const [selected, setSelected] = useState<LinkProviderDetail | null>(null);
  const [selectedConnectionName, setSelectedConnectionName] = useState("default");
  const [runDetail, setRunDetail] = useState<LinkRunDetail | null>(null);
  const [online, setOnline] = useState(false);
  const [oauthConfigs, setOAuthConfigs] = useState<LinkOAuthConfigSummary[]>(
    [],
  );
  const [providerTarget, setProviderTarget] = useAtom(linkProviderTargetAtom);
  const [deleteTarget, setDeleteTarget] = useState<LinkConnectionSummary | null>(null);

  const refresh = useCallback(async () => {
    const runtime = await getLinkRuntimeState();
    setOnline(runtime.phase === "online");
    if (runtime.phase !== "online") {
      setProviders([]);
      setConnections([]);
      setRuns([]);
      setOAuthConfigs([]);
      return;
    }
    const [nextProviders, nextConnections, nextRuns, nextOAuthConfigs] =
      await Promise.all([
        listLinkProviders(),
        listLinkConnections(),
        listLinkRuns({
          limit: 50,
          ...(runService.trim() ? { service: runService.trim() } : {}),
          ...(runOutcome === "success" ? { ok: true } : {}),
          ...(runOutcome === "failure" ? { ok: false } : {}),
        }),
        listLinkOAuthConfigs(),
      ]);
    setProviders(nextProviders);
    setConnections(nextConnections);
    setRuns(nextRuns.items);
    setRunCursor(nextRuns.nextCursor);
    setOAuthConfigs(nextOAuthConfigs);
  }, [runOutcome, runService]);
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
      .then((provider) => {
        setSelectedConnectionName("default");
        setSelected(provider);
        setProviderTarget(null);
      })
      .catch(() => toast.error("无法打开连接器详情"));
  }, [online, providerTarget, setProviderTarget]);
  const categories = useMemo(
    () =>
      [
        ...new Set(providers.flatMap((provider) => provider.categories ?? [])),
      ].sort(),
    [providers],
  );
  const visibleProviders = providers.filter((provider) => {
    const configured = connections.some(
      (connection) =>
        connection.service === provider.service && connection.configured,
    );
    return (
      (!query ||
        `${provider.displayName} ${provider.service} ${provider.description ?? ""}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (category === "all" || provider.categories?.includes(category)) &&
      (connectionState === "all" ||
        (connectionState === "configured") === configured)
    );
  });

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-auto p-6">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold">连接器</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            由本机 OpenConnector Link 提供，连接凭据不会进入渲染器。
          </p>
        </div>
        <Badge variant={online ? "default" : "secondary"}>
          {online ? "本地运行中" : "未启用"}
        </Badge>
      </div>
      {!online ? (
        <div className="lume-panel p-5 text-sm text-muted-foreground">
          请在「设置 → Link 运行时」中启用本地运行时。
        </div>
      ) : (
        <Tabs defaultValue="catalog" className="min-h-0">
          <TabsList>
            <TabsTrigger value="catalog">应用目录</TabsTrigger>
            <TabsTrigger value="connections">我的连接</TabsTrigger>
            <TabsTrigger value="runs">运行记录</TabsTrigger>
          </TabsList>
          <TabsContent value="catalog" className="space-y-4 pt-4">
            <div className="flex flex-wrap gap-2">
              <Input
                className="max-w-xs"
                placeholder="搜索应用"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Filter
                value={category}
                onValueChange={setCategory}
                label="分类"
                items={[
                  ["all", "全部分类"],
                  ...categories.map((item) => [item, item]),
                ]}
              />
              <Filter
                value={connectionState}
                onValueChange={setConnectionState}
                label="状态"
                items={[
                  ["all", "全部状态"],
                  ["configured", "已连接"],
                  ["unconfigured", "需处理"],
                ]}
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visibleProviders.map((provider) => (
                <Button
                  variant="ghost"
                  key={provider.service}
                  className="lume-panel h-auto justify-start p-4 text-left transition-colors hover:bg-muted/40"
                  onClick={() =>
                    void getLinkProvider(provider.service).then((detail) => {
                      setSelectedConnectionName("default");
                      setSelected(detail);
                    }).catch(() => toast.error("无法打开连接器详情"))
                  }
                >
                  <div className="w-full">
                    <div className="flex items-center justify-between gap-2">
                      <strong>{provider.displayName}</strong>
                      {connections.some(
                        (item) =>
                          item.service === provider.service && item.configured,
                      ) && <Badge>已连接</Badge>}
                    </div>
                    <p className="mt-2 line-clamp-2 whitespace-normal text-xs text-muted-foreground">
                      {provider.description || provider.service}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-1">
                      {provider.categories?.slice(0, 3).map((item) => (
                        <Badge key={item} variant="secondary">
                          {item}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </Button>
              ))}
            </div>
          </TabsContent>
          <TabsContent value="connections" className="space-y-3 pt-4">
            {connections.length ? (
              connections.map((connection) => (
                <div
                  className="lume-panel flex items-center justify-between gap-3 p-4"
                  key={`${connection.service}:${connection.connectionName}`}
                >
                  <div>
                    <div className="font-medium">
                      {connection.profile?.displayName ||
                        connection.connectionName}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {connection.service} · {connection.authType}
                      {connection.default ? " · 默认" : ""}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void getLinkProvider(connection.service).then((detail) => {
                          setSelectedConnectionName(connection.connectionName);
                          setSelected(detail);
                        }).catch(() => toast.error("无法打开连接器详情"))
                      }
                    >
                      管理
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteTarget(connection)}
                    >
                      断开
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <Empty>还没有连接。</Empty>
            )}
          </TabsContent>
          <TabsContent value="runs" className="space-y-3 pt-4">
            <div className="flex flex-wrap gap-2">
              <Input
                className="max-w-xs"
                placeholder="按 Provider service 筛选"
                value={runService}
                onChange={(event) => setRunService(event.target.value)}
              />
              <Filter
                value={runOutcome}
                onValueChange={setRunOutcome}
                label="结果"
                items={[
                  ["all", "全部结果"],
                  ["success", "成功"],
                  ["failure", "失败"],
                ]}
              />
            </div>
            {runs.length ? (
              <>
                {runs.map((run) => (
                  <Button
                    variant="ghost"
                    className="lume-panel flex h-auto w-full items-center justify-between p-4 text-left"
                    key={run.id}
                    onClick={() => void getLinkRun(run.id).then(setRunDetail).catch(() => toast.error("无法读取运行详情"))}
                  >
                    <div>
                      <div className="font-medium">
                        {String(run.actionId || run.id)}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {String(run.service || "")} ·{" "}
                        {String(run.startedAt || "")}
                      </div>
                    </div>
                    <Badge variant="secondary">
                      {run.ok ? "成功" : "失败"} · {run.durationMs}ms
                    </Badge>
                  </Button>
                ))}
                {runCursor && (
                  <Button
                    variant="outline"
                    disabled={runBusy}
                    onClick={() => {
                      setRunBusy(true);
                      void listLinkRuns({
                        limit: 50,
                        cursor: runCursor,
                        ...(runService.trim() ? { service: runService.trim() } : {}),
                        ...(runOutcome === "success" ? { ok: true } : {}),
                        ...(runOutcome === "failure" ? { ok: false } : {}),
                      })
                        .then((page) => {
                          setRuns((current) => [...current, ...page.items]);
                          setRunCursor(page.nextCursor);
                        })
                        .catch(() => toast.error("无法读取更多运行记录"))
                        .finally(() => setRunBusy(false));
                    }}
                  >
                    加载更多
                  </Button>
                )}
              </>
            ) : (
              <Empty>暂无运行记录。</Empty>
            )}
          </TabsContent>
        </Tabs>
      )}
      <ProviderDialog
        provider={selected}
        initialConnectionName={selectedConnectionName}
        oauthConfig={oauthConfigs.find(
          (item) => item.service === selected?.service,
        )}
        connections={connections.filter(
          (item) => item.service === selected?.service,
        )}
        onClose={() => setSelected(null)}
        onSaved={async () => {
          await refresh();
          setSelected(null);
        }}
      />
      <Dialog
        open={Boolean(runDetail)}
        onOpenChange={(open) => !open && setRunDetail(null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>运行详情</DialogTitle>
            <DialogDescription>{runDetail?.id}</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[55vh] overflow-auto rounded-md bg-muted p-3 text-xs">
            {JSON.stringify(runDetail, null, 2)}
          </pre>
        </DialogContent>
      </Dialog>
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

function ProviderDialog({
  provider,
  initialConnectionName,
  oauthConfig,
  connections,
  onClose,
  onSaved,
}: {
  provider: LinkProviderDetail | null;
  initialConnectionName: string;
  oauthConfig?: LinkOAuthConfigSummary;
  connections: LinkConnectionSummary[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [connectionName, setConnectionName] = useState("default");
  const [authIndex, setAuthIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [oauth, setOAuth] = useState<LinkOAuthSession | null>(null);
  const [actionDetail, setActionDetail] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValues(oauthConfig?.clientId ? { clientId: oauthConfig.clientId } : {});
    setConnectionName(initialConnectionName);
    setAuthIndex(0);
    setOAuth(null);
    setActionDetail(null);
    if (provider?.service) {
      void listLinkOAuthSessions()
        .then((sessions) => setOAuth(sessions.find((session) => session.service === provider.service && session.status === "pending") ?? null))
        .catch(() => undefined);
    }
  }, [provider?.service, initialConnectionName, oauthConfig?.clientId]);
  useEffect(() => {
    if (!oauth || oauth.status !== "pending") return;
    const timer = setInterval(
      () =>
        void getLinkOAuthStatus(oauth.state)
          .then((next) => {
            setOAuth(next);
            if (next.status === "authorized") void onSaved();
          })
          .catch((error) =>
            setOAuth({
              ...oauth,
              status: "error",
              error: error instanceof Error ? error.message : "授权失败",
            }),
          ),
      1500,
    );
    return () => clearInterval(timer);
  }, [oauth, onSaved]);
  if (!provider) return null;
  const auth = provider.auth?.[authIndex] ?? { type: "no_auth" };
  const fields = credentialFields(auth);
  const isOAuth = auth.type === "oauth2";
  const oauthFields = credentialFields({
    fields: (oauthConfig?.auth.clientConfigFields ??
      auth.clientConfigFields) as unknown,
  }) as Array<
    LinkCredentialField & {
      location?: "extra" | "secretExtra";
      defaultValue?: string;
    }
  >;
  const save = async () => {
    setBusy(true);
    try {
      if (isOAuth) {
        const extra = Object.fromEntries(
          oauthFields
            .filter((field) => field.location !== "secretExtra")
            .map((field) => [
              field.key,
              values[field.key] ?? field.defaultValue ?? "",
            ]),
        );
        const secretExtra = Object.fromEntries(
          oauthFields
            .filter((field) => field.location === "secretExtra")
            .map((field) => [field.key, values[field.key] ?? ""]),
        );
        if (!oauthConfig?.configured || values.clientSecret || auth.tokenEndpointAuthMethod === "none")
          await saveLinkOAuthConfig(
            provider.service,
            values.clientId || "",
            values.clientSecret || "",
            extra,
            secretExtra,
          );
        const session = await startLinkOAuth(provider.service, connectionName);
        setOAuth(session);
        await openExternal(session.authorizationUrl || "");
      } else {
        await upsertLinkConnection({
          service: provider.service,
          connectionName,
          authType: String(auth.type),
          credentials: Object.fromEntries(
            fields.map((field) => [field.key, values[field.key] ?? ""]),
          ),
        });
        setValues({});
        await onSaved();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存连接失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{provider.displayName}</DialogTitle>
          <DialogDescription>
            {provider.description || provider.service}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Label>连接名称</Label>
          <Input
            value={connectionName}
            onChange={(event) => setConnectionName(event.target.value)}
          />
          <Label>认证方式</Label>
          <Select
            value={String(authIndex)}
            onValueChange={(value) => {
              setAuthIndex(Number(value ?? 0));
              setValues({});
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {provider.auth.map((item, index) => (
                <SelectItem key={`${item.type}:${index}`} value={String(index)}>
                  {authLabel(String(item.type))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {isOAuth ? (
            <>
              <SecretField
                label="OAuth Client ID"
                value={values.clientId ?? ""}
                onChange={(value) =>
                  setValues((prev) => ({ ...prev, clientId: value }))
                }
                secret={false}
              />
              <SecretField
                label="OAuth Client Secret"
                value={values.clientSecret ?? ""}
                onChange={(value) =>
                  setValues((prev) => ({ ...prev, clientSecret: value }))
                }
                secret
              />
              {oauthFields.map((field) => (
                <SecretField
                  key={field.key}
                  label={field.label}
                  value={values[field.key] ?? field.defaultValue ?? ""}
                  onChange={(value) => setValues((prev) => ({ ...prev, [field.key]: value }))}
                  secret={field.secret || field.location === "secretExtra"}
                  textarea={field.inputType === "textarea" || field.inputType === "json"}
                />
              ))}
              {oauthConfig?.expectedRedirectUri && (
                <div className="rounded-md bg-muted p-3 text-xs">
                  <div className="font-medium">OAuth 回调地址</div>
                  <div className="mt-1 break-all font-mono text-muted-foreground">{oauthConfig.expectedRedirectUri}</div>
                </div>
              )}
            </>
          ) : (
            fields.map((field) => (
              <SecretField
                key={field.key}
                label={field.label}
                value={values[field.key] ?? ""}
                onChange={(value) =>
                  setValues((prev) => ({ ...prev, [field.key]: value }))
                }
                secret={field.secret}
                textarea={
                  field.inputType === "textarea" || field.inputType === "json"
                }
              />
            ))
          )}
          {oauth && (
            <div className="rounded-md bg-muted p-3 text-xs">
              授权状态：{oauth.status}
              {oauth.error ? ` · ${oauth.error}` : ""}
            </div>
          )}
          {connections.length > 0 && (
            <div className="text-xs text-muted-foreground">
              现有连接：
              {connections.map((item) => item.connectionName).join("、")}
            </div>
          )}
          {provider.actions && provider.actions.length > 0 && (
            <div className="space-y-2 border-t pt-3">
              <div className="text-sm font-medium">Actions（{provider.actions.length}）</div>
              <div className="max-h-36 space-y-1 overflow-auto">
                {provider.actions.map((action) => (
                  <Button
                    key={action.id}
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start px-2 py-1.5 text-left"
                    onClick={() => void getLinkAction(action.id).then(setActionDetail).catch(() => toast.error("无法读取 Action 详情"))}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">{action.id}</span>
                      {action.description && <span className="block truncate text-xs text-muted-foreground">{action.description}</span>}
                    </span>
                  </Button>
                ))}
              </div>
              {actionDetail != null && (
                <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(actionDetail, null, 2)}</pre>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          {oauth?.status === "pending" && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void cancelLinkOAuth(oauth.state).then(setOAuth)}
            >
              取消授权
            </Button>
          )}
          <Button disabled={busy || oauth?.status === "pending"} onClick={() => void save()}>
            {isOAuth ? "保存并在系统浏览器授权" : "保存连接"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function credentialFields(
  auth: Record<string, unknown>,
): LinkCredentialField[] {
  const configured = auth.type === "api_key"
    ? [
        {
          key: "apiKey",
          label: typeof auth.label === "string" ? auth.label : "API Key",
          inputType: "password" as const,
          required: true,
          secret: true,
          ...(typeof auth.placeholder === "string" ? { placeholder: auth.placeholder } : {}),
          ...(typeof auth.description === "string" ? { description: auth.description } : {}),
        },
        ...(Array.isArray(auth.extraFields) ? auth.extraFields : []),
      ]
    : auth.fields;
  return Array.isArray(configured)
    ? configured.filter((item): item is LinkCredentialField =>
        Boolean(
          item &&
          typeof item === "object" &&
          typeof (item as LinkCredentialField).key === "string",
        ),
      )
    : [];
}
function authLabel(type: string): string {
  return ({ no_auth: "无需认证", api_key: "API Key", custom_credential: "自定义凭据", oauth2: "OAuth 2.0" } as Record<string, string>)[type] ?? type;
}
function SecretField({
  label,
  value,
  onChange,
  secret,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secret: boolean;
  textarea?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {textarea ? (
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          type={secret ? "password" : "text"}
          value={value}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}
function Filter({
  value,
  onValueChange,
  label,
  items,
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  items: string[][];
}) {
  return (
    <Select value={value} onValueChange={(next) => next && onValueChange(next)}>
      <SelectTrigger>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {items.map(([id, text]) => (
          <SelectItem key={id} value={id}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="lume-panel p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
