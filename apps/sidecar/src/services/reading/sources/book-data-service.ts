import type { ReadingSearchResult } from "@lume/shared";
import { GutenbergClient } from "./gutenberg-client";
import { PoetryClient } from "./poetry-client";
import type { ReadingSourceBook, ReadingSourceFetch, ReadingSourceResult } from "./types";
import { WereadClient } from "./weread-client";

interface BookDataServiceInput {
  wereadApiKey?: string | null;
  fetch?: ReadingSourceFetch;
}

export class BookDataService {
  private readonly wereadApiKey?: string;
  private readonly fetchImpl?: ReadingSourceFetch;

  constructor(input: BookDataServiceInput = {}) {
    this.wereadApiKey = input.wereadApiKey?.trim() || undefined;
    this.fetchImpl = input.fetch;
  }

  async loadWereadShelf(): Promise<ReadingSourceResult<ReadingSourceBook[]>> {
    return this.trySource(async () => this.createWereadClient().shelf(), []);
  }

  async loadWereadNotebooks(): Promise<ReadingSourceResult<unknown[]>> {
    return this.trySource(async () => this.createWereadClient().notebooks(), []);
  }

  async loadWereadBookmarks(bookId: string): Promise<ReadingSourceResult<unknown[]>> {
    return this.trySource(async () => this.createWereadClient().bookmarks(bookId), []);
  }

  async loadWereadBestBookmarks(bookId: string): Promise<ReadingSourceResult<unknown[]>> {
    return this.trySource(async () => this.createWereadClient().bestBookmarks(bookId), []);
  }

  async loadWereadPublicReviews(bookId: string, listType = "hot"): Promise<ReadingSourceResult<unknown[]>> {
    return this.trySource(async () => this.createWereadClient().publicReviews(bookId, listType), []);
  }

  async searchWeread(query: string, limit = 10): Promise<ReadingSourceResult<ReadingSearchResult[]>> {
    return this.trySource(async () => this.createWereadClient().search(query, limit), []);
  }

  async searchGutenberg(query: string, limit = 10): Promise<ReadingSourceResult<ReadingSearchResult[]>> {
    return this.trySource(async () => new GutenbergClient({ fetch: this.fetchImpl }).search(query, limit), []);
  }

  async fetchPoem(): Promise<ReadingSourceResult<ReadingSearchResult | null>> {
    return this.trySource(async () => new PoetryClient({ fetch: this.fetchImpl }).randomPoem(), null);
  }

  private createWereadClient(): WereadClient {
    if (!this.wereadApiKey) {
      throw new Error("未连接微信读书");
    }
    return new WereadClient({
      apiKey: this.wereadApiKey,
      fetch: this.fetchImpl
    });
  }

  private async trySource<T>(load: () => Promise<T>, fallback: T): Promise<ReadingSourceResult<T>> {
    try {
      return {
        ok: true,
        data: await load()
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        data: fallback
      };
    }
  }
}
