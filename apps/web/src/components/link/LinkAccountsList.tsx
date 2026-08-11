import type { LinkConnectionSummary } from "@lume/shared";
import { authLabel } from "@/lib/link-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface LinkAccountsListProps {
  connections: LinkConnectionSummary[];
  onReconnect: (connectionName: string) => void;
  onRequestDelete: (connectionName: string) => void;
}

export function LinkAccountsList({ connections, onReconnect, onRequestDelete }: LinkAccountsListProps) {
  if (connections.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="px-0.5 text-sm font-medium text-[var(--text-1)]">已连接账户（{connections.length}）</div>
      <div className="space-y-1.5">
        {connections.map((conn) => (
          <article key={conn.connectionName} className="grid gap-2.5 rounded-md border border-[var(--lume-border-subtle)] bg-card px-3 py-2.5">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-[var(--text-1)]">{conn.connectionName}</span>
                {conn.default && <Badge variant="success">默认</Badge>}
              </div>
              <div className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 text-xs text-[var(--text-3)]">
                <span className="truncate">{conn.profile?.displayName || conn.profile?.accountId || "已保存凭据"}</span>
                <span>{authLabel(conn.authType)}</span>
              </div>
            </div>
            </div>
            <div className="flex shrink-0 gap-1 border-t border-[var(--lume-border-subtle)] pt-2">
              <Button variant="outline" size="sm" onClick={() => onReconnect(conn.connectionName)}>重连</Button>
              <Button variant="destructive" size="sm" onClick={() => onRequestDelete(conn.connectionName)}>断开</Button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
