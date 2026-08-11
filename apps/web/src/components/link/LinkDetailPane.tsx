import type { LinkConnectionSummary, LinkProviderDetail } from "@lume/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
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
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {/* 头部 */}
      <div className="flex items-start justify-between gap-3 border-b border-[var(--lume-border-subtle)] p-4">
        <div className="flex min-w-0 items-start gap-3">
          <ProviderIcon service={provider.service} displayName={provider.displayName} iconUrl={provider.iconUrl} size={36} />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-[var(--text-1)]">{provider.displayName}</h2>
            <p className="mt-0.5 text-xs text-[var(--text-3)]">{provider.description || provider.service}</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" aria-label="关闭连接器详情" title="关闭" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      {/* 连接操作 */}
      <div className="grid gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-[var(--text-1)]">{configured ? "已连接" : "未连接"}</span>
          <Button size="sm" onClick={onConnect}>{configured ? "添加连接" : "连接"}</Button>
        </div>
        {authTypes.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {authTypes.map((t) => <Badge key={t} variant="secondary">{authLabel(t)}</Badge>)}
          </div>
        )}
        <LinkAccountsList connections={connections} onReconnect={onReconnect} onRequestDelete={onRequestDelete} />
        {/* 详情 dl */}
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1 border-t border-[var(--lume-border-subtle)] pt-3 text-xs">
          <dt className="text-[var(--text-3)]">服务</dt>
          <dd className="truncate font-mono text-[var(--text-2)]">{provider.service}</dd>
          {provider.categories?.length ? (
            <>
              <dt className="text-[var(--text-3)]">分类</dt>
              <dd className="truncate text-[var(--text-2)]">{provider.categories.join("、")}</dd>
            </>
          ) : null}
          {provider.actions?.length ? (
            <>
              <dt className="text-[var(--text-3)]">可用操作</dt>
              <dd className="text-[var(--text-2)]">{provider.actions.length} 个</dd>
            </>
          ) : null}
        </dl>
      </div>
    </div>
  );
}
