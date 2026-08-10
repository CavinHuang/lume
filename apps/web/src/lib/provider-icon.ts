import { LINK_ICONS } from "./generated/link-icons";

export type IconKind = "lobehub" | "simpleIcon" | "image" | "letter";

// @lobehub/icons 覆盖的 AI/开发者品牌（深路径 Mono 组件存在性验证）
export const LOBEHUB_SERVICES = [
  "github", "notion", "microsoft", "figma", "vercel",
  "openai", "anthropic", "cohere", "perplexity",
] as const;

// service(小写)→ simple-icons slug 手工修正（须与生成脚本一致）
const SLUG_OVERRIDES: Record<string, string> = {
  active_campaign: "activecampaign",
  google_calendar: "googlecalendar",
  microsoft_teams: "microsoftteams",
};

export function serviceToSimpleSlug(service: string): string | null {
  const key = service.toLowerCase();
  const slug = SLUG_OVERRIDES[key] ?? key.replaceAll("_", "-");
  return slug;
}

export function decideIconKind(service: string, iconUrl?: string): IconKind {
  const key = service.toLowerCase();
  if ((LOBEHUB_SERVICES as readonly string[]).includes(key)) return "lobehub";
  if (LINK_ICONS[key]) return "simpleIcon";
  if (iconUrl) return "image";
  return "letter";
}

export function initialOf(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed[0].toUpperCase() : "?";
}

const LETTER_COLORS = ["#3b82f6", "#8b5cf6", "#ec4899", "#d97706", "#10b981", "#06b6d4", "#ef4444", "#6366f1"];

export function colorForSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return LETTER_COLORS[Math.abs(hash) % LETTER_COLORS.length];
}
