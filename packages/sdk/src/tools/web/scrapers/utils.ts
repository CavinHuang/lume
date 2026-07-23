import { runtimeLoadBinary, isRecord } from "./compat.js";
import { renderStructuredBinary } from "../../web-fetch-content.js";

export { isRecord };
export type { AgentStorage } from "./compat.js";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface BinaryFetchSuccess {
  ok: true;
  buffer: Uint8Array;
  contentDisposition?: string;
}
export type BinaryFetchResult = BinaryFetchSuccess | { ok: false; error?: string };

export async function fetchBinary(url: string, timeout = 20, signal?: AbortSignal): Promise<BinaryFetchResult> {
  const result = await runtimeLoadBinary(url, { timeout, signal });
  if (!result.ok) return { ok: false, error: result.error ?? `HTTP ${result.status}` };
  return { ok: true, buffer: result.bytes, contentDisposition: result.headers.get("content-disposition") ?? undefined };
}

export async function convertWithMarkit(buffer: Uint8Array, extension: string, _timeout = 20, _signal?: AbortSignal): Promise<{ content: string; ok: boolean; error?: string }> {
  const result = await renderStructuredBinary(buffer, extension, `document${extension}`);
  return result ? { content: result.markdown, ok: true } : { content: "", ok: false, error: `unsupported document type: ${extension}` };
}
