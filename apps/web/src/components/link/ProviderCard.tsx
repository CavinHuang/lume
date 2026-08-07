import type { LinkProviderSummary } from "@lume/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface ProviderCardProps {
  provider: LinkProviderSummary;
  configured: boolean;
  onOpen: (service: string) => void;
}

export function ProviderCard({ provider, configured, onOpen }: ProviderCardProps) {
  return (
    <Button
      variant="ghost"
      className="lume-panel flex h-[128px] flex-col items-start justify-start overflow-hidden p-4 text-left transition-colors hover:bg-muted/40"
      onClick={() => onOpen(provider.service)}
    >
      <div className="flex items-center gap-2">
        <strong className="truncate">{provider.displayName}</strong>
        {configured && <Badge>已连接</Badge>}
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
        {provider.description || provider.service}
      </p>
      {provider.categories?.length ? (
        <div className="mt-auto flex flex-wrap gap-1 pt-2">
          {provider.categories.slice(0, 3).map((item) => (
            <Badge key={item} variant="secondary">{item}</Badge>
          ))}
        </div>
      ) : null}
    </Button>
  );
}
