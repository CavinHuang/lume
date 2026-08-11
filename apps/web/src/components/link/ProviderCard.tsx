import type { LinkProviderSummary } from "@lume/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "./ProviderIcon";

interface ProviderCardProps {
  provider: LinkProviderSummary;
  configured: boolean;
  selected?: boolean;
  onOpen: (service: string) => void;
}

export function ProviderCard({ provider, configured, selected, onOpen }: ProviderCardProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => onOpen(provider.service)}
      className={cn(
        "group/card relative flex h-[68px] w-full cursor-pointer justify-start overflow-hidden rounded-md border border-[var(--lume-border-subtle)] bg-card px-2.5 py-1.5 text-left whitespace-normal transition-colors",
        "hover:border-[var(--lume-focus-ring)] hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/40",
        selected && "border-[var(--lume-focus-ring)] bg-[var(--lume-accent-soft)] before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-r-full before:bg-[var(--lume-accent)]",
      )}
    >
      <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
        <ProviderIcon service={provider.service} displayName={provider.displayName} iconUrl={provider.iconUrl} size={20} />
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-sm font-medium text-[var(--text-1)]">{provider.displayName}</span>
          <span className="truncate text-[11px] text-[var(--text-3)]">{provider.description || provider.service}</span>
        </span>
        <StatusMark configured={configured} />
      </span>
    </Button>
  );
}

function StatusMark({ configured }: { configured: boolean }) {
  if (!configured) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span
        className={cn(
          "size-2 rounded-full",
          "bg-[var(--lume-success)] shadow-[0_0_0_3px_color-mix(in_oklab,var(--lume-success)_18%,transparent)]",
        )}
      />
    </span>
  );
}
