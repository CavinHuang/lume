export type LinkCategoryFilterId =
  | "cross-border-commerce"
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
  services?: readonly string[];
  primary?: boolean;
}

const CROSS_BORDER_COMMERCE_SERVICES = [
  "lingxing",
  "lingxing_mcp",
  "sellersprite",
  "sellerspace",
  "shopify",
  "17track",
  "adobe_commerce",
  "aftership",
  "asin_data_api",
  "baselinker",
  "big_commerce",
  "captainbi",
  "cin7_core",
  "easypost",
  "helium10",
  "jumpseller",
  "linkfox",
  "printify",
  "ship_bob",
  "shipengine",
  "shippo",
  "ship_station",
  "shopify_admin",
  "shopify_partner",
  "shopify_storefront",
  "sif",
  "sorftime",
  "store_leads",
  "storecensus",
  "triple_whale",
  "vtex",
  "woocommerce",
] as const;

export const LINK_CATEGORY_FILTERS: readonly LinkCategoryFilterDefinition[] = [
  {
    id: "cross-border-commerce",
    label: "跨境电商",
    categories: [],
    services: CROSS_BORDER_COMMERCE_SERVICES,
    primary: true,
  },
  { id: "ai", label: "AI", categories: ["AI"], primary: true },
  { id: "productivity", label: "效率", categories: ["Productivity", "Project Management"], primary: true },
  { id: "marketing", label: "营销", categories: ["Marketing"] },
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

export function matchesLinkCategory(service: string, categories: readonly string[], id: LinkCategoryFilterId): boolean {
  const definition = categoryById.get(id);
  if (!definition) return false;
  if (id === "other") return categories.length === 0 || categories.every((category) => !mappedCategories.has(category));
  return (
    definition.services?.includes(service) === true ||
    categories.some((category) => definition.categories.includes(category))
  );
}
