import type { ReadingSearchResult } from "@lume/shared";
import type { ReadingSourceFetch } from "./types";

interface GutenbergClientInput {
  fetch?: ReadingSourceFetch;
  baseUrl?: string;
}

export class GutenbergClient {
  private readonly fetchImpl: ReadingSourceFetch;
  private readonly baseUrl: string;

  constructor(input: GutenbergClientInput = {}) {
    this.fetchImpl = input.fetch ?? fetch;
    this.baseUrl = (input.baseUrl ?? "https://gutendex.com").replace(/\/+$/, "");
  }

  async search(query: string, limit = 10): Promise<ReadingSearchResult[]> {
    const url = `${this.baseUrl}/books/?search=${encodeURIComponent(query)}&page_size=${limit}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Gutenberg 请求失败: ${response.status}`);
    }
    const payload = await response.json();
    const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
    return results.filter(isRecord).map(mapGutendexBook);
  }
}

function mapGutendexBook(item: Record<string, unknown>): ReadingSearchResult {
  const id = readString(item.id) ?? (typeof item.id === "number" ? String(item.id) : undefined);
  const formats = isRecord(item.formats) ? item.formats : {};
  const authors = Array.isArray(item.authors) ? item.authors.filter(isRecord) : [];
  const author = authors.map((entry) => readString(entry.name)).find(Boolean);
  const summaries = Array.isArray(item.summaries) ? item.summaries : [];
  const summary = summaries.map(readString).find(Boolean);
  return {
    source: "gutenberg",
    externalId: id,
    title: readString(item.title) ?? "Untitled Gutenberg Book",
    author,
    coverUrl: readString(formats["image/jpeg"]),
    url: id ? `https://www.gutenberg.org/ebooks/${id}` : undefined,
    summary
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
