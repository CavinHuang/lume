import type { ReadingSearchResult } from "@lume/shared";
import type { ReadingSourceFetch } from "./types";

interface PoetryClientInput {
  fetch?: ReadingSourceFetch;
  baseUrl?: string;
}

export class PoetryClient {
  private readonly fetchImpl: ReadingSourceFetch;
  private readonly baseUrl: string;

  constructor(input: PoetryClientInput = {}) {
    this.fetchImpl = input.fetch ?? fetch;
    this.baseUrl = (input.baseUrl ?? "https://v2.jinrishici.com").replace(/\/+$/, "");
  }

  async randomPoem(): Promise<ReadingSearchResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/one.json`);
    if (!response.ok) {
      throw new Error(`诗词请求失败: ${response.status}`);
    }
    const payload = await response.json();
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : {};
    const origin = isRecord(data.origin) ? data.origin : {};
    const content = readString(data.content) ?? "";
    const title = readString(origin.title) ?? "诗词札记";
    const dynasty = readString(origin.dynasty);
    const author = readString(origin.author);
    return {
      source: "poetry",
      externalId: title,
      title,
      author,
      summary: [dynasty, author].filter(Boolean).join(" · ") + (content ? `：${content}` : "")
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
