import type { LinkProviderSummary } from "@lume/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "./ProviderIcon";

interface ProviderCardProps {
  provider: LinkProviderSummary;
  configured: boolean;
  needsSetup: boolean;
  noSetup: boolean;
  selected?: boolean;
  onOpen: (service: string) => void;
}

export function ProviderCard({ provider, configured, needsSetup, noSetup, selected, onOpen }: ProviderCardProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onOpen(provider.service)}
      className={cn(
        "group/card relative flex h-[68px] w-full cursor-pointer justify-start overflow-hidden rounded-md border border-[var(--lume-border-subtle)] bg-card px-2.5 py-1.5 text-left whitespace-normal transition-[background-color,border-color,box-shadow,transform]",
        "hover:border-[var(--lume-focus-ring)] hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/40",
        selected && "border-[var(--lume-focus-ring)] bg-[var(--lume-accent-soft)] shadow-[inset_0_0_0_1px_var(--lume-focus-ring)] before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-r-full before:bg-[var(--lume-accent)]",
      )}
    >
      <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <ProviderIcon service={provider.service} displayName={provider.displayName} iconUrl={provider.iconUrl} size={36} />
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-sm font-medium text-[var(--text-1)]">{provider.displayName}</span>
          <span className="truncate text-[11px] text-[var(--text-3)]">{provider.description || provider.service}</span>
        </span>
        <StatusMark configured={configured} needsSetup={needsSetup} noSetup={noSetup} />
      </span>
    </Button>
  );
}

function StatusMark({ configured, needsSetup, noSetup }: { configured: boolean; needsSetup: boolean; noSetup: boolean }) {
  if (configured) return <Badge variant="success" className="px-1.5">已连接</Badge>;
  if (needsSetup) return <Badge variant="warning" className="px-1.5">需配置</Badge>;
  if (noSetup) return <Badge variant="secondary" className="px-1.5">可直接使用</Badge>;
  return null;
}
