export type LinkCategoryFilterId =
  | "ai"
  | "productivity"
  | "marketing"
  | "communication"
  | "developer"
  | "data-storage"
  | "design-media"
  | "finance"
  | "security"
  | "location"
  | "social"
  | "other";

export type LinkFilter = "all" | "connected" | "needsSetup" | "noSetup" | `category:${LinkCategoryFilterId}`;

export interface LinkCategoryFilterDefinition {
  id: LinkCategoryFilterId;
  label: string;
  categories: readonly string[];
  primary?: boolean;
}

export const LINK_CATEGORY_FILTERS: readonly LinkCategoryFilterDefinition[] = [
  { id: "ai", label: "AI", categories: ["AI"], primary: true },
  { id: "productivity", label: "效率", categories: ["Productivity", "Project Management"], primary: true },
  { id: "marketing", label: "营销", categories: ["Marketing"], primary: true },
  { id: "communication", label: "沟通", categories: ["Communication"] },
  { id: "developer", label: "开发者", categories: ["Developer Tools", "Infrastructure"] },
  { id: "data-storage", label: "数据与存储", categories: ["Data", "Storage"] },
  { id: "design-media", label: "设计与媒体", categories: ["Design & Media", "Design", "Media", "Video"] },
  { id: "finance", label: "金融", categories: ["Finance", "Subscriptions"] },
  { id: "security", label: "安全", categories: ["Security"] },
  { id: "location", label: "地图与位置", categories: ["Location"] },
  { id: "social", label: "社交", categories: ["Social"] },
  { id: "other", label: "其他", categories: [] },
];

const categoryById = new Map(LINK_CATEGORY_FILTERS.map((filter) => [filter.id, filter]));
const mappedCategories = new Set(LINK_CATEGORY_FILTERS.flatMap((filter) => filter.categories));

export function linkCategoryFilterValue(id: LinkCategoryFilterId): `category:${LinkCategoryFilterId}` {
  return `category:${id}`;
}

export function linkCategoryIdFromFilter(filter: string): LinkCategoryFilterId | null {
  if (!filter.startsWith("category:")) return null;
  const id = filter.slice("category:".length) as LinkCategoryFilterId;
  return categoryById.has(id) ? id : null;
}

export function matchesLinkCategory(categories: readonly string[], id: LinkCategoryFilterId): boolean {
  const definition = categoryById.get(id);
  if (!definition) return false;
  if (id === "other") return categories.length === 0 || categories.every((category) => !mappedCategories.has(category));
  return categories.some((category) => definition.categories.includes(category));
}
