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
    <div className="space-y-2">
      <div className="text-sm font-medium text-[var(--text-1)]">已连接账户（{connections.length}）</div>
      <div className="space-y-1.5">
        {connections.map((conn) => (
          <div key={conn.connectionName} className="flex items-center justify-between gap-2 rounded-md border border-[var(--lume-border-subtle)] bg-card px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-[var(--text-1)]">{conn.connectionName}</span>
                {conn.default && <Badge variant="secondary">默认</Badge>}
              </div>
              <div className="truncate text-xs text-[var(--text-3)]">
                {conn.profile?.displayName || conn.profile?.accountId || authLabel(conn.authType)}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button variant="outline" size="sm" onClick={() => onReconnect(conn.connectionName)}>重连</Button>
              <Button variant="ghost" size="sm" className="text-[var(--lume-danger)]" onClick={() => onRequestDelete(conn.connectionName)}>断开</Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
