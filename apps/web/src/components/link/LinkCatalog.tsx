import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { computeColumnCount, PROVIDER_GRID, rowCount } from "@/lib/provider-grid";
import { linkServicePriority } from "@/lib/provider-ranking";
import type { LinkConnectionSummary, LinkOAuthConfigSummary, LinkProviderSummary } from "@lume/shared";
import { LinkToolbar, type FilterCounts, type LinkFilter } from "./LinkToolbar";
import { ProviderCard } from "./ProviderCard";
import { resolveLinkOAuthSetupState } from "./link-provider-state";
import { LINK_CATEGORY_FILTERS, linkCategoryIdFromFilter, matchesLinkCategory } from "./link-category-filters";

interface LinkCatalogProps {
  providers: LinkProviderSummary[];
  connections: LinkConnectionSummary[];
  oauthConfigs: LinkOAuthConfigSummary[];
  query: string;
  onQueryChange: (v: string) => void;
  filter: LinkFilter;
  onFilterChange: (v: LinkFilter) => void;
  selectedService: string | null;
  onOpen: (service: string) => void;
}

function providerStatus(
  provider: LinkProviderSummary,
  configuredServices: Set<string>,
  oauthConfiguredServices: Set<string>,
  authTypes: string[],
) {
  const configured = configuredServices.has(provider.service);
  const noSetup = authTypes.length === 0 || authTypes.every((authType) => authType === "no_auth");
  const oauthSetup = resolveLinkOAuthSetupState(authTypes, oauthConfiguredServices.has(provider.service));
  return { configured, noSetup, needsSetup: !configured && oauthSetup === "required" };
}

export function LinkCatalog({
  providers, connections, oauthConfigs, query, onQueryChange, filter, onFilterChange, selectedService, onOpen,
}: LinkCatalogProps) {
  const configuredServices = useMemo(
    () => new Set(connections.filter((c) => c.configured).map((c) => c.service)),
    [connections],
  );
  const oauthConfiguredServices = useMemo(
    () => new Set(oauthConfigs.filter((config) => config.configured).map((config) => config.service)),
    [oauthConfigs],
  );

  const annotated = useMemo(
    () =>
      providers.map((p) => ({
        provider: p,
        status: providerStatus(p, configuredServices, oauthConfiguredServices, p.authTypes ?? []),
      })),
    [providers, configuredServices, oauthConfiguredServices],
  );

  const counts: FilterCounts = useMemo(
    () => ({
      all: annotated.length,
      connected: annotated.filter((a) => a.status.configured).length,
      noSetup: annotated.filter((a) => a.status.noSetup).length,
      needsSetup: annotated.filter((a) => a.status.needsSetup).length,
      categories: Object.fromEntries(
        LINK_CATEGORY_FILTERS.map((category) => [
          category.id,
          annotated.filter(({ provider }) => matchesLinkCategory(provider.categories, category.id)).length,
        ]),
      ) as FilterCounts["categories"],
    }),
    [annotated],
  );

  const visible = useMemo(() => {
    const categoryFilter = linkCategoryIdFromFilter(filter);
    return annotated
      .filter(({ provider, status }) => {
        const matchesQuery =
          !query ||
          `${provider.displayName} ${provider.service} ${provider.description ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase());
        const matchesFilter =
          filter === "all" ||
          (filter === "connected" && status.configured) ||
          (filter === "noSetup" && status.noSetup) ||
          (filter === "needsSetup" && status.needsSetup) ||
          (categoryFilter !== null && matchesLinkCategory(provider.categories, categoryFilter));
        return matchesQuery && matchesFilter;
      })
      .sort((a, b) => {
        const configuredRank = Number(b.status.configured) - Number(a.status.configured);
        if (configuredRank !== 0) return configuredRank;
        const priority = linkServicePriority(a.provider.service) - linkServicePriority(b.provider.service);
        if (priority !== 0) return priority;
        return a.provider.displayName.localeCompare(b.provider.displayName);
      });
  }, [annotated, query, filter]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useLayoutEffect(() => {
    const node = gridRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    setContainerWidth(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const columns = computeColumnCount(containerWidth);
  const rows = rowCount(visible.length, columns);
  const rowVirtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => PROVIDER_GRID.cardHeight + PROVIDER_GRID.gap,
    overscan: PROVIDER_GRID.overscanRows,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-[var(--lume-border-subtle)] px-3 py-2">
        <LinkToolbar
          query={query}
          onQueryChange={onQueryChange}
          filter={filter}
          onFilterChange={onFilterChange}
          counts={counts}
        />
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-3">
        {visible.length === 0 ? (
          <div className="grid gap-1 rounded-lg border border-[var(--lume-border-subtle)] bg-muted/30 px-3 py-3">
            <div className="text-sm font-medium text-[var(--text-1)]">无匹配连接器</div>
            <div className="text-xs text-[var(--text-3)]">尝试更换关键词或清除筛选。</div>
          </div>
        ) : null}
        {/*
          gridRef 必须恒挂载：useLayoutEffect deps=[] 只在首挂时 attach ResizeObserver。
          若放进 visible.length>0 分支，empty↔non-empty 切换会卸载 gridRef → cleanup disconnect
          → 重挂时 effect 不重跑 → containerWidth 冻结 0、列数降级 1、窗口缩放失效。
          空态下 rows=0 → height=0、无 virtual item，div 占位零成本。
        */}
        <div ref={gridRef} className="relative" style={{ height: rows ? rowVirtualizer.getTotalSize() : 0 }}>
          {rowVirtualizer.getVirtualItems().map((vRow) => (
            <div
              key={vRow.key}
              className="absolute left-0 top-0 grid gap-2"
              style={{
                transform: `translateY(${vRow.start}px)`,
                width: "100%",
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {Array.from({ length: columns }).map((_, col) => {
                const entry = visible[vRow.index * columns + col];
                if (!entry) return null;
                return (
                  <ProviderCard
                    key={entry.provider.service}
                    provider={entry.provider}
                    configured={entry.status.configured}
                    needsSetup={entry.status.needsSetup}
                    noSetup={entry.status.noSetup}
                    selected={entry.provider.service === selectedService}
                    onOpen={onOpen}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
