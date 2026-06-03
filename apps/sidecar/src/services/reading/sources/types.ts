import type { ReadingAddBookInput, ReadingSearchResult } from "@lume/shared";

export type ReadingSourceFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ReadingSourceResult<T> {
  ok: boolean;
  data: T;
  error?: string;
}

export type ReadingSourceBook = ReadingAddBookInput;
export type ReadingSourceSearchResult = ReadingSearchResult;
