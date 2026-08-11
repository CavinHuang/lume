import { SearchField } from "@/components/ui/search-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type LinkFilter = "all" | "connected" | "noSetup";

export interface FilterCounts {
  all: number;
  connected: number;
  noSetup: number;
}

interface LinkToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  filter: LinkFilter;
  onFilterChange: (value: LinkFilter) => void;
  counts: FilterCounts;
}

export function LinkToolbar({ query, onQueryChange, filter, onFilterChange, counts }: LinkToolbarProps) {
  const items: Array<{ value: LinkFilter; label: string; count: number }> = [
    { value: "all", label: "全部", count: counts.all },
    { value: "connected", label: "已连接", count: counts.connected },
    { value: "noSetup", label: "免配置", count: counts.noSetup },
  ];
  return (
    <div className="grid w-full min-w-0 gap-2">
      <SearchField
        placeholder="搜索连接器…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <ToggleGroup className="justify-start overflow-x-auto" value={filter} onValueChange={(v) => onFilterChange(v as LinkFilter)}>
        {items.map((item) => (
          <ToggleGroupItem key={item.value} value={item.value} className="shrink-0 border border-[var(--lume-border-subtle)]">
            {item.label}
            <span className="tabular-nums text-[var(--text-3)]">{item.count}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
