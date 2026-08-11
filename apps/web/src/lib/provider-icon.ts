import { LINK_ICONS, LINK_ICON_URLS } from "./generated/link-icons";

export type IconKind = "lobehub" | "simpleIcon" | "community" | "letter";

// theSVG 加载失败后，Lobe Icons 承接 AI 品牌，Simple Icons 承接通用 SaaS 品牌。
export const LOBEHUB_SERVICES = [
  "openai", "anthropic", "cohere", "perplexity",
] as const;

export function decideIconKind(service: string, skipCommunity = false): IconKind {
  const key = service.toLowerCase();
  if (!skipCommunity && LINK_ICON_URLS[key]) return "community";
  if ((LOBEHUB_SERVICES as readonly string[]).includes(key)) return "lobehub";
  if (LINK_ICONS[key]) return "simpleIcon";
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
