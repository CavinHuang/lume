import type { ReadingSearchResult } from "@lume/shared";
import type { ReadingSourceFetch, ReadingSourceResult } from "./types";
import { WereadClient } from "./weread-client";
import { WereadPublicClient } from "./weread-public-client";

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

  async loadWereadBookmarks(bookId: string): Promise<ReadingSourceResult<unknown[]>> {
    return this.trySource(async () => this.createWereadClient().bookmarks(bookId), []);
  }

  async loadWereadBestBookmarks(bookId: string): Promise<ReadingSourceResult<unknown[]>> {
    return this.trySource(async () => this.createWereadClient().bestBookmarks(bookId), []);
  }

  async searchWeread(query: string, limit = 10): Promise<ReadingSourceResult<ReadingSearchResult[]>> {
    return this.trySource(async () => this.createWereadClient().search(query, limit), []);
  }

  async searchWereadPublic(query: string, limit = 10): Promise<ReadingSourceResult<ReadingSearchResult[]>> {
    return this.trySource(async () => new WereadPublicClient({ fetch: this.fetchImpl }).search(query, limit), []);
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
