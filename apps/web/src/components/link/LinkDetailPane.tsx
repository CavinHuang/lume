import { useState } from "react";
import type { LinkConnectionSummary, LinkOAuthConfigSummary, LinkProviderDetail, LinkRuntimeMode } from "@lume/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronUp, KeyRound, ListChecks, Settings2, ShieldCheck, X } from "lucide-react";
import { authLabel } from "@/lib/link-auth";
import { ProviderIcon } from "./ProviderIcon";
import { LinkAccountsList } from "./LinkAccountsList";
import { getSupportedLinkActions, resolveLinkOAuthSetupState } from "./link-provider-state";

interface LinkDetailPaneProps {
  provider: LinkProviderDetail;
  connections: LinkConnectionSummary[];
  oauthConfig?: LinkOAuthConfigSummary;
  runtimeMode: LinkRuntimeMode;
  onConnect: () => void;
  onConfigureProvider: () => void;
  onClose: () => void;
  onReconnect: (connectionName: string) => void;
  onRequestDelete: (connectionName: string) => void;
}

export function LinkDetailPane({
  provider,
  connections,
  oauthConfig,
  runtimeMode,
  onConnect,
  onConfigureProvider,
  onClose,
  onReconnect,
  onRequestDelete,
}: LinkDetailPaneProps) {
  const connectedCount = connections.filter((connection) => connection.configured).length;
  const connected = connectedCount > 0;
  const authTypes = provider.authTypes?.length ? provider.authTypes : provider.auth?.map((a) => String(a.type)) ?? [];
  const oauthSetup = resolveLinkOAuthSetupState(authTypes, oauthConfig?.configured ?? false);
  const supportsOAuth = oauthSetup !== "not_supported";
  const actions = getSupportedLinkActions(provider.actions ?? []);
  const [expandedActionService, setExpandedActionService] = useState<string | null>(null);
  const actionsExpanded = expandedActionService === provider.service;
  const visibleActions = actionsExpanded ? actions : actions.slice(0, 8);
  return (
    <div className="grid min-w-0 gap-3">
      <section className="grid gap-3 border-b border-[var(--lume-border-subtle)] pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <ProviderIcon service={provider.service} displayName={provider.displayName} iconUrl={provider.iconUrl} size={40} />
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="truncate text-sm font-semibold text-[var(--text-1)]">{provider.displayName}</h2>
                <Badge variant={connected ? "success" : connections.length > 0 ? "warning" : "secondary"}>
                  {connected ? `已连接 ${connectedCount} 个账户` : connections.length > 0 ? "有待完成账户" : "未连接账户"}
                </Badge>
              </div>
              <p className="mt-1 break-words text-xs text-[var(--text-3)]">{provider.description || provider.service}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="关闭连接器详情" title="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
      </section>

      {supportsOAuth ? (
        <section className="grid gap-2.5 rounded-lg border border-[var(--lume-border-subtle)] bg-card p-3">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-[var(--text-2)]">
                {oauthSetup === "configured" ? <ShieldCheck className="size-4" /> : <Settings2 className="size-4" />}
              </div>
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium text-[var(--text-1)]">连接器配置</h3>
                  <OAuthSetupBadge state={oauthSetup} />
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-3)]">
                  OAuth 应用由{runtimeMode === "remote" ? "已有部署的" : "本机"} Link 运行时保存，所有 {provider.displayName} 账户共用这一份配置。
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={onConfigureProvider}>
              <Settings2 className="size-3.5" />{oauthSetup === "configured" ? "编辑" : "配置"}
            </Button>
          </div>
          {oauthConfig?.clientId ? (
            <div className="grid gap-1 rounded-md border border-[var(--lume-border-subtle)] bg-muted/20 px-3 py-2 text-xs">
              <span className="text-[var(--text-3)]">Client ID</span>
              <code className="truncate text-[var(--text-2)]">{oauthConfig.clientId}</code>
            </div>
          ) : null}
          {oauthSetup === "required" ? (
            <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-[var(--text-2)]">
              添加账户前，需要先完成 OAuth 应用配置。
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="grid gap-2.5 rounded-lg border border-[var(--lume-border-subtle)] bg-card p-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-[var(--text-1)]">连接账户</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-3)]">每个账户独立保存授权，可为同一应用添加多个账户。</p>
          </div>
          <Button size="sm" onClick={onConnect}>
            <KeyRound className="size-3.5" />添加账户
          </Button>
        </div>
        {authTypes.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-xs text-[var(--text-3)]">支持</span>
            {authTypes.map((type) => <Badge key={type} variant="secondary">{authLabel(type)}</Badge>)}
          </div>
        ) : null}
        {connections.length > 0 ? (
          <LinkAccountsList connections={connections} onReconnect={onReconnect} onRequestDelete={onRequestDelete} />
        ) : (
          <div className="rounded-md border border-dashed border-[var(--lume-border-subtle)] px-3 py-3 text-xs leading-relaxed text-[var(--text-3)]">
            还没有连接账户。添加后，智能体可以通过这个连接器访问对应账户。
          </div>
        )}
        {!connected && authTypes.includes("no_auth") ? (
          <div className="rounded-md border border-[var(--lume-border-subtle)] bg-muted/30 px-3 py-2 text-xs text-[var(--text-3)]">
            此连接器无需账户授权即可使用，也可以添加可选配置。
          </div>
        ) : null}
      </section>

      <section className="grid gap-2.5 rounded-lg border border-[var(--lume-border-subtle)] bg-card p-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <div className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-[var(--text-2)]">
              <ListChecks className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium text-[var(--text-1)]">支持的能力</h3>
                <Badge variant="secondary">{actions.length} 个</Badge>
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-3)]">
                智能体可以通过此连接器调用以下操作。
              </p>
            </div>
          </div>
        </div>
        {actions.length > 0 ? (
          <div id={`link-actions-${provider.service}`} className="overflow-hidden rounded-md border border-[var(--lume-border-subtle)]">
            {visibleActions.map((action) => (
              <div key={action.id} className="grid gap-0.5 border-b border-[var(--lume-border-subtle)] px-3 py-2.5 last:border-b-0">
                <div className="truncate text-xs font-medium text-[var(--text-1)]" title={action.id}>
                  {formatActionName(action.name)}
                </div>
                <p className="line-clamp-2 text-xs leading-relaxed text-[var(--text-3)]">
                  {action.description || action.id}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--lume-border-subtle)] px-3 py-3 text-xs text-[var(--text-3)]">
            此服务暂未声明可供智能体调用的能力。
          </div>
        )}
        {actions.length > 8 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="justify-center"
            aria-expanded={actionsExpanded}
            aria-controls={`link-actions-${provider.service}`}
            onClick={() => setExpandedActionService(actionsExpanded ? null : provider.service)}
          >
            {actionsExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {actionsExpanded ? "收起能力列表" : `查看全部 ${actions.length} 个能力`}
          </Button>
        ) : null}
      </section>

      <section className="grid gap-3">
        <div className="grid gap-1.5">
          <h3 className="px-0.5 text-sm font-medium text-[var(--text-1)]">提供方信息</h3>
          <dl className="overflow-hidden rounded-md border border-[var(--lume-border-subtle)] text-xs">
            <DetailRow label="服务" value={provider.service} mono />
            {provider.categories?.length ? (
              <DetailRow label="分类" value={provider.categories.join("、")} />
            ) : null}
            <DetailRow label="认证方式" value={authTypes.length ? authTypes.map(authLabel).join("、") : "无需认证"} />
          </dl>
        </div>
      </section>
    </div>
  );
}

function OAuthSetupBadge({ state }: { state: ReturnType<typeof resolveLinkOAuthSetupState> }) {
  if (state === "configured") return <Badge variant="success">已配置</Badge>;
  if (state === "required") return <Badge variant="warning">需要配置</Badge>;
  return <Badge variant="secondary">可选配置</Badge>;
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] border-b border-[var(--lume-border-subtle)] last:border-b-0">
      <dt className="bg-muted/25 px-3 py-2 text-[var(--text-3)]">{label}</dt>
      <dd className={mono ? "truncate px-3 py-2 font-mono text-[var(--text-2)]" : "px-3 py-2 text-[var(--text-2)]"}>{value}</dd>
    </div>
  );
}

function formatActionName(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
