import type TurndownService from "turndown";
import { createTurndown, normalizeTablesHtml } from "../../html-to-markdown.js";
import { runtimeLoadPage, type AgentStorage, getScraperRuntime, formatBytes, tryParseJson } from "./compat.js";

export interface RenderResult {
  url: string;
  finalUrl: string;
  contentType: string;
  method: string;
  content: string;
  fetchedAt: string;
  truncated: boolean;
  notes: string[];
}

export type SpecialHandler = (
  url: string,
  timeout: number,
  signal?: AbortSignal,
  storage?: AgentStorage | null,
) => Promise<RenderResult | null>;

export const MAX_OUTPUT_CHARS = 500_000;
export const MAX_BYTES = 50 * 1024 * 1024;

export interface LoadPageOptions {
  timeout?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  maxBytes?: number;
  signal?: AbortSignal;
  skipBodyForContentType?: (contentType: string) => boolean;
}

export interface LoadPageResult {
  content: string;
  contentType: string;
  finalUrl: string;
  ok: boolean;
  status?: number;
  truncated?: boolean;
  error?: string;
  bodySkipped?: boolean;
}

export async function loadPage(url: string, options: LoadPageOptions = {}): Promise<LoadPageResult> {
  const result = await runtimeLoadPage(url, options);
  return result;
}

export function finalizeOutput(content: string): { content: string; truncated: boolean } {
  const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
  return { content: cleaned.slice(0, MAX_OUTPUT_CHARS), truncated: cleaned.length > MAX_OUTPUT_CHARS };
}

let turndown: TurndownService | undefined;

export async function htmlToBasicMarkdown(html: string): Promise<string> {
  turndown ??= createTurndown();
  const cleaned = normalizeTablesHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  return turndown.turndown(cleaned).trim();
}

export function buildResult(
  md: string,
  opts: { url: string; finalUrl?: string; method: string; fetchedAt: string; notes?: string[]; contentType?: string },
): RenderResult {
  const output = finalizeOutput(md);
  return {
    url: opts.url,
    finalUrl: opts.finalUrl ?? opts.url,
    contentType: opts.contentType ?? "text/markdown",
    method: opts.method,
    content: output.content,
    fetchedAt: opts.fetchedAt,
    truncated: output.truncated,
    notes: opts.notes ?? [],
  };
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatIsoDate(value?: string | number | Date): string {
  if (value == null) return "";
  if (typeof value === "string") {
    const prefix = value.match(/^\d{4}-\d{2}-\d{2}/);
    if (prefix) return prefix[0];
  }
  try { return new Date(value).toISOString().split("T")[0] ?? ""; } catch { return ""; }
}

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&#x2F;/g, "/").replace(/&nbsp;/g, " ");
}

export function formatMediaDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export type LocalizedText = string | Record<string, string | null> | null | undefined;
export function getLocalizedText(value: LocalizedText, defaultLocale?: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  return (defaultLocale && value[defaultLocale]) ?? value["en-US"] ?? value.en_US ?? value.en ?? Object.values(value).find(v => typeof v === "string") ?? undefined;
}

export function looksLikeHtml(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.startsWith("<head") || trimmed.startsWith("<body");
}

export function getActiveStorage(): AgentStorage | null | undefined {
  return getScraperRuntime()?.storage;
}

export { formatBytes, tryParseJson };
