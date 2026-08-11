import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchField } from "@/components/ui/search-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { LINK_CATEGORY_FILTERS, linkCategoryFilterValue, type LinkCategoryFilterId, type LinkFilter } from "./link-category-filters";

export type { LinkFilter } from "./link-category-filters";

export interface FilterCounts {
  all: number;
  connected: number;
  needsSetup: number;
  noSetup: number;
  categories: Record<LinkCategoryFilterId, number>;
}

interface LinkToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  filter: LinkFilter;
  onFilterChange: (value: LinkFilter) => void;
  counts: FilterCounts;
}

export function LinkToolbar({ query, onQueryChange, filter, onFilterChange, counts }: LinkToolbarProps) {
  const primaryCategories = LINK_CATEGORY_FILTERS.filter((category) => category.primary && counts.categories[category.id] > 0);
  const overflowCategories = LINK_CATEGORY_FILTERS.filter((category) => !category.primary && counts.categories[category.id] > 0);
  const overflowItems: Array<{ value: LinkFilter; label: string; count: number }> = [
    { value: "connected", label: "已连接", count: counts.connected },
    { value: "needsSetup", label: "需配置", count: counts.needsSetup },
    ...overflowCategories.map((category) => ({
      value: linkCategoryFilterValue(category.id),
      label: category.label,
      count: counts.categories[category.id],
    })),
  ];
  const selectedOverflowItem = overflowItems.find((item) => item.value === filter);

  return (
    <div className="grid w-full min-w-0 gap-2">
      <SearchField
        placeholder="搜索服务商"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto pb-px">
        <ToggleGroup className="flex-nowrap" value={filter} onValueChange={(value) => onFilterChange(value as LinkFilter)}>
          <FilterItem value="all" label="全部" count={counts.all} />
          <FilterItem value="noSetup" label="可直接使用" count={counts.noSetup} />
          {primaryCategories.map((category) => (
            <FilterItem
              key={category.id}
              value={linkCategoryFilterValue(category.id)}
              label={category.label}
              count={counts.categories[category.id]}
            />
          ))}
        </ToggleGroup>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={(
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn("shrink-0", selectedOverflowItem && "border-[var(--lume-focus-ring)] bg-[var(--lume-accent-soft)]")}
              />
            )}
          >
            {selectedOverflowItem?.label ?? "更多"}
            <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuRadioGroup value={filter} onValueChange={(value) => onFilterChange(value as LinkFilter)}>
              <div className="px-3 py-1.5 text-[11px] font-medium text-[var(--text-3)]">状态</div>
              {overflowItems.slice(0, 2).map((item) => (
                <OverflowFilterItem key={item.value} item={item} />
              ))}
              <DropdownMenuSeparator />
              <div className="px-3 py-1.5 text-[11px] font-medium text-[var(--text-3)]">分类</div>
              {overflowItems.slice(2).map((item) => (
                <OverflowFilterItem key={item.value} item={item} />
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function FilterItem({ value, label, count }: { value: LinkFilter; label: string; count: number }) {
  return (
    <ToggleGroupItem value={value} className="shrink-0 border border-[var(--lume-border-subtle)]">
      {label}<span className="tabular-nums text-[var(--text-3)]">{count}</span>
    </ToggleGroupItem>
  );
}

function OverflowFilterItem({ item }: { item: { value: LinkFilter; label: string; count: number } }) {
  return (
    <DropdownMenuRadioItem value={item.value} className="[&>span:last-child]:flex-1">
      <span className="min-w-0 truncate">{item.label}</span>
      <span className="ml-auto tabular-nums text-[var(--text-3)]">{item.count}</span>
    </DropdownMenuRadioItem>
  );
}
