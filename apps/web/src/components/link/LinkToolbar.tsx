import { SearchField } from "@/components/ui/search-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type LinkFilter = "all" | "connected" | "noSetup" | "needsAttention";

export interface FilterCounts {
  all: number;
  connected: number;
  noSetup: number;
  needsAttention: number;
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
    { value: "needsAttention", label: "需处理", count: counts.needsAttention },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchField
        className="max-w-xs"
        placeholder="搜索连接器…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <ToggleGroup value={filter} onValueChange={(v) => onFilterChange(v as LinkFilter)}>
        {items.map((item) => (
          <ToggleGroupItem key={item.value} value={item.value}>
            {item.label}
            <span className="tabular-nums text-[var(--text-3)]">{item.count}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
