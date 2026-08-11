import type { LinkConnectionSummary, LinkProviderDetail } from "@lume/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KeyRound, Plug, X } from "lucide-react";
import { authLabel } from "@/lib/link-auth";
import { ProviderIcon } from "./ProviderIcon";
import { LinkAccountsList } from "./LinkAccountsList";

interface LinkDetailPaneProps {
  provider: LinkProviderDetail;
  connections: LinkConnectionSummary[];
  onConnect: () => void;
  onClose: () => void;
  onReconnect: (connectionName: string) => void;
  onRequestDelete: (connectionName: string) => void;
}

export function LinkDetailPane({ provider, connections, onConnect, onClose, onReconnect, onRequestDelete }: LinkDetailPaneProps) {
  const configured = connections.some((c) => c.configured);
  const authTypes = provider.authTypes?.length ? provider.authTypes : provider.auth?.map((a) => String(a.type)) ?? [];
  return (
    <div className="grid min-w-0 gap-3">
      <section className="grid gap-3 border-b border-[var(--lume-border-subtle)] pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <ProviderIcon service={provider.service} displayName={provider.displayName} iconUrl={provider.iconUrl} size={36} />
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="truncate text-sm font-semibold text-[var(--text-1)]">{provider.displayName}</h2>
                <Badge variant={configured ? "success" : "secondary"}>{configured ? "已连接" : "未连接"}</Badge>
              </div>
              <p className="mt-1 break-words text-xs text-[var(--text-3)]">{provider.description || provider.service}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="关闭连接器详情" title="关闭" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="grid gap-2.5 border-t border-[var(--lume-border-subtle)] pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-[var(--text-1)]">{configured ? "连接账户" : "连接此应用"}</span>
            <Button size="sm" onClick={onConnect}>
              {configured ? <KeyRound className="size-3.5" /> : <Plug className="size-3.5" />}
              {configured ? "添加连接" : "连接"}
            </Button>
          </div>
          {authTypes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-xs text-[var(--text-3)]">支持</span>
              {authTypes.map((t) => <Badge key={t} variant="secondary">{authLabel(t)}</Badge>)}
            </div>
          )}
          {!configured && authTypes.includes("no_auth") ? (
            <div className="rounded-md border border-[var(--lume-border-subtle)] bg-muted/30 px-3 py-2 text-xs text-[var(--text-3)]">
              此连接器无需账号授权，可直接使用；也可以添加可选配置。
            </div>
          ) : null}
        </div>
      </section>
      <section className="grid gap-3">
        <LinkAccountsList connections={connections} onReconnect={onReconnect} onRequestDelete={onRequestDelete} />
        <div className="grid gap-1.5">
          <h3 className="px-0.5 text-sm font-medium text-[var(--text-1)]">提供方信息</h3>
          <dl className="overflow-hidden rounded-md border border-[var(--lume-border-subtle)] text-xs">
            <DetailRow label="服务" value={provider.service} mono />
            {provider.categories?.length ? (
              <DetailRow label="分类" value={provider.categories.join("、")} />
            ) : null}
            {provider.actions?.length ? (
              <DetailRow label="可用操作" value={`${provider.actions.length} 个`} />
            ) : null}
            <DetailRow label="认证方式" value={authTypes.length ? authTypes.map(authLabel).join("、") : "无需认证"} />
          </dl>
        </div>
      </section>
    </div>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] border-b border-[var(--lume-border-subtle)] last:border-b-0">
      <dt className="bg-muted/25 px-3 py-2 text-[var(--text-3)]">{label}</dt>
      <dd className={mono ? "truncate px-3 py-2 font-mono text-[var(--text-2)]" : "px-3 py-2 text-[var(--text-2)]"}>{value}</dd>
    </div>
  );
}
