import { LINK_ICONS } from "./generated/link-icons";

export type IconKind = "lobehub" | "simpleIcon" | "image" | "letter";

// Lobe Icons 只承接 AI 品牌；通用 SaaS 品牌交给覆盖更广、带品牌色的 Simple Icons。
export const LOBEHUB_SERVICES = [
  "openai", "anthropic", "cohere", "perplexity",
] as const;

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
