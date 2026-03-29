import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

export const WEB_TOOL_NAMES = ["web_search", "web_fetch"] as const;

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_WEB_FETCH_MAX_CHARS = 12_000;
const DEFAULT_WEB_SEARCH_COUNT = 5;
const MAX_WEB_SEARCH_COUNT = 10;
const MAX_WEB_FETCH_CHARS = 40_000;
const DEFAULT_WEB_SEARCH_PROVIDER = "duckduckgo";
const WEB_SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;
const WEB_SEARCH_MAX_ATTEMPTS = 2;
const WEB_SEARCH_TOTAL_TIMEOUT_MS = 40_000;
const DDG_SEARCH_ENDPOINTS = [
  "https://duckduckgo.com/html/",
  "https://html.duckduckgo.com/html/"
];

type WebSearchCacheEntry = { data: Record<string, unknown>; expiresAt: number };
const webSearchCache = new Map<string, WebSearchCacheEntry>();

function getWebSearchCache(key: string): Record<string, unknown> | null {
  const entry = webSearchCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) webSearchCache.delete(key);
    return null;
  }
  return entry.data;
}

function setWebSearchCache(key: string, data: Record<string, unknown>): void {
  webSearchCache.set(key, { data, expiresAt: Date.now() + WEB_SEARCH_CACHE_TTL_MS });
}

function toTextResult<TDetails>(details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(details, null, 2)
      }
    ],
    details
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  return Math.min(max, Math.max(min, parsed));
}

function pickOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...(truncated)...`;
}

function extractSimpleTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function stripHtmlTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeDdgRedirectUrl(rawUrl: string): string {
  const normalized = rawUrl.replace(/&amp;/gi, "&");
  const index = normalized.indexOf("uddg=");
  if (index < 0) return normalized;
  const encoded = normalized.slice(index + 5).split("&")[0] ?? "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return normalized;
  }
}

function parseDdgHtmlResults(
  html: string,
  query: string,
  maxResults: number
): Array<{ title: string; url: string; snippet: string }> {
  const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi;

  const links: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) && links.length < maxResults + 2) {
    links.push({
      url: decodeDdgRedirectUrl(match[1] ?? ""),
      title: stripHtmlTags(match[2] ?? "")
    });
  }
  while ((match = snippetRegex.exec(html)) && snippets.length < maxResults + 2) {
    snippets.push(stripHtmlTags(match[1] ?? ""));
  }

  if (links.length === 0) {
    return [{
      title: `No results found for: ${query}`,
      url: "",
      snippet: ""
    }];
  }

  return links.slice(0, maxResults).map((item, index) => ({
    title: item.title || `Result ${index + 1}`,
    url: item.url,
    snippet: snippets[index] ?? ""
  }));
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (host === "0.0.0.0" || host === "127.0.0.1") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d{1,3})\./);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init?.headers);
    if (!headers.has("user-agent")) {
      headers.set("user-agent", "Lume-Agent/1.0 (+web_tools)");
    }
    return await fetch(url, {
      ...(init ?? {}),
      method: init?.method ?? "GET",
      signal: controller.signal,
      headers
    });
  } finally {
    clearTimeout(timer);
  }
}

async function raceWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<T> {
  if (timeoutMs <= 0) {
    onTimeout?.();
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }, timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<{ response: Response; bodyText: string }> {
  const controller = new AbortController();
  const headers = new Headers(init?.headers);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", "Lume-Agent/1.0 (+web_tools)");
  }
  const response = await raceWithTimeout(
    fetch(url, {
      ...(init ?? {}),
      method: init?.method ?? "GET",
      signal: controller.signal,
      headers
    }),
    timeoutMs,
    () => controller.abort()
  );
  const bodyText = await raceWithTimeout(
    response.text(),
    timeoutMs,
    () => controller.abort()
  );
  return { response, bodyText };
}

async function fetchJsonWithTimeout<TPayload>(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<{ response: Response; payload: TPayload }> {
  const controller = new AbortController();
  const headers = new Headers(init?.headers);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", "Lume-Agent/1.0 (+web_tools)");
  }
  const response = await raceWithTimeout(
    fetch(url, {
      ...(init ?? {}),
      method: init?.method ?? "GET",
      signal: controller.signal,
      headers
    }),
    timeoutMs,
    () => controller.abort()
  );
  const payload = await raceWithTimeout(
    response.json() as Promise<TPayload>,
    timeoutMs,
    () => controller.abort()
  );
  return { response, payload };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("aborted") || message.includes("abort");
}

function asWebSearchErrorDetails(
  error: unknown,
  provider: "duckduckgo" | "brave",
  query: string,
  timeoutMs: number,
  attempt: number
): {
  error: string;
  code: string;
  retryable: boolean;
  provider: "duckduckgo" | "brave";
  query: string;
  timeoutMs: number;
  attempt: number;
  results: [];
} {
  const abort = isAbortError(error);
  return {
    error: abort
      ? `web_search(${provider}) 请求超时（>${timeoutMs}ms）`
      : (error instanceof Error ? error.message : String(error)),
    code: abort ? "WEB_SEARCH_TIMEOUT" : "WEB_SEARCH_REQUEST_FAILED",
    retryable: true,
    provider,
    query,
    timeoutMs,
    attempt,
    results: []
  };
}

export function createWebTools(): AgentTool[] {
  return [
    {
      name: "web_search",
      label: "web_search",
      description: `Search the web for current information. Use when you need:
- Real-time data (news, prices, events)
- Information beyond your knowledge cutoff
- Verify facts or find documentation

Providers: duckduckgo (default, free), brave/tavily (need API key)
Example: { "query": "React 19 new features", "count": 5 }`,
      parameters: Type.Object({
        query: Type.String({ minLength: 1, description: "Search keywords" }),
        provider: Type.Optional(Type.Union([Type.Literal("duckduckgo"), Type.Literal("ddg"), Type.Literal("brave"), Type.Literal("tavily")])),
        braveApiKey: Type.Optional(Type.String()),
        tavilyApiKey: Type.Optional(Type.String()),
        count: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_WEB_SEARCH_COUNT })),
        country: Type.Optional(Type.String()),
        search_lang: Type.Optional(Type.String()),
        ui_lang: Type.Optional(Type.String()),
        freshness: Type.Optional(Type.String({ description: "pd=day, pw=week, pm=month, py=year (brave only)" }))
      }),
      async execute(_toolCallId, args) {
        const params = (args ?? {}) as Record<string, unknown>;
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (!query) {
          return toTextResult({ error: "query 不能为空", results: [] });
        }
        const providerRaw = typeof params.provider === "string" ? params.provider.trim().toLowerCase() : "";
        const provider = providerRaw === "ddg" ? "duckduckgo" : (providerRaw || DEFAULT_WEB_SEARCH_PROVIDER);
        const count = clampInt(params.count, 1, MAX_WEB_SEARCH_COUNT, DEFAULT_WEB_SEARCH_COUNT);
        const country = pickOptionalString(params.country);
        const searchLang = pickOptionalString(params.search_lang);
        const uiLang = pickOptionalString(params.ui_lang);
        const freshness = pickOptionalString(params.freshness);
        const braveApiKey = (
          typeof params.braveApiKey === "string" ? params.braveApiKey.trim() : process.env.BRAVE_SEARCH_API_KEY
        ) ?? "";
        const tavilyApiKey = (
          typeof params.tavilyApiKey === "string" ? params.tavilyApiKey.trim() : process.env.TAVILY_API_KEY
        ) ?? "";
        const startedAt = Date.now();
        const remainingBudgetMs = (): number => WEB_SEARCH_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);

        const cacheKey = `${provider}:${query}:${count}:${country ?? ""}:${searchLang ?? ""}:${uiLang ?? ""}:${freshness ?? ""}`;
        const cached = getWebSearchCache(cacheKey);
        if (cached) {
          return toTextResult({ ...cached, cached: true });
        }

        try {
          if (provider === "duckduckgo") {
            let ddgLastError: ReturnType<typeof asWebSearchErrorDetails> | null = null;
            let ddgAttempt = 0;
            const hasFallbackProvider = Boolean(braveApiKey || tavilyApiKey);
            const reservedFallbackBudgetMs = hasFallbackProvider ? 12_000 : 0;
            for (const endpoint of DDG_SEARCH_ENDPOINTS) {
              if (remainingBudgetMs() <= reservedFallbackBudgetMs) break;

              const ddgUrl = new URL(endpoint);
              ddgUrl.searchParams.set("q", query);
              if (country) {
                ddgUrl.searchParams.set("kl", country.toLowerCase());
              }

              for (let attempt = 1; attempt <= WEB_SEARCH_MAX_ATTEMPTS; attempt += 1) {
                ddgAttempt += 1;
                try {
                  const requestTimeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, remainingBudgetMs()));
                  const { response, bodyText } = await fetchTextWithTimeout(ddgUrl.toString(), requestTimeoutMs, {
                    headers: {
                      "accept-language": [uiLang, searchLang, "en-US", "en;q=0.9"].filter(Boolean).join(",")
                    }
                  });
                  if (!response.ok) {
                    if (response.status >= 500 && attempt < WEB_SEARCH_MAX_ATTEMPTS) {
                      await new Promise((resolve) => setTimeout(resolve, 800));
                      continue;
                    }
                    ddgLastError = {
                      error: `web_search(duckduckgo) 请求失败: ${response.status} (${endpoint})`,
                      code: "WEB_SEARCH_HTTP_ERROR",
                      retryable: response.status >= 500,
                      provider: "duckduckgo",
                      query,
                      timeoutMs: requestTimeoutMs,
                      attempt: ddgAttempt,
                      results: []
                    };
                    break;
                  }
                  const rows = parseDdgHtmlResults(bodyText, query, count);
                  const result = {
                    provider: "duckduckgo",
                    query,
                    endpoint,
                    count: rows.filter((item) => item.url).length,
                    country,
                    search_lang: searchLang,
                    ui_lang: uiLang,
                    results: rows
                  };
                  setWebSearchCache(cacheKey, result);
                  return toTextResult(result);
                } catch (error) {
                  const timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, remainingBudgetMs()));
                  const errorDetails = asWebSearchErrorDetails(error, "duckduckgo", query, timeoutMs, ddgAttempt);
                  ddgLastError = {
                    ...errorDetails,
                    error: `${errorDetails.error} (${endpoint})`
                  };
                  if (attempt < WEB_SEARCH_MAX_ATTEMPTS && ddgLastError.retryable) {
                    if (remainingBudgetMs() <= reservedFallbackBudgetMs) {
                      break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 800));
                    continue;
                  }
                  break;
                }
              }
            }
            if (remainingBudgetMs() <= 0 && !hasFallbackProvider) {
              return toTextResult({
                error: `web_search 总超时（>${WEB_SEARCH_TOTAL_TIMEOUT_MS}ms）`,
                code: "WEB_SEARCH_TOTAL_TIMEOUT",
                provider: "duckduckgo",
                query,
                results: []
              });
            }
            const baseFallbackError = ddgLastError ?? {
              error: "web_search(duckduckgo) 请求失败",
              code: "WEB_SEARCH_REQUEST_FAILED",
              retryable: true,
              provider: "duckduckgo",
              query,
              timeoutMs: DEFAULT_TIMEOUT_MS,
              attempt: WEB_SEARCH_MAX_ATTEMPTS,
              results: []
            };

            if (braveApiKey) {
              const braveUrl = new URL("https://api.search.brave.com/res/v1/web/search");
              braveUrl.searchParams.set("q", query);
              braveUrl.searchParams.set("count", String(count));
              if (country) braveUrl.searchParams.set("country", country);
              if (searchLang) braveUrl.searchParams.set("search_lang", searchLang);
              if (uiLang) braveUrl.searchParams.set("ui_lang", uiLang);
              if (freshness) braveUrl.searchParams.set("freshness", freshness);

              const fallbackTimeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, remainingBudgetMs()));
              const { response, payload } = await fetchJsonWithTimeout<{
                web?: {
                  results?: Array<{ title?: string; url?: string; description?: string }>;
                };
              }>(braveUrl.toString(), fallbackTimeoutMs, {
                headers: {
                  Accept: "application/json",
                  "X-Subscription-Token": braveApiKey
                }
              });
              if (response.ok) {
                const rows = (payload.web?.results ?? []).slice(0, count).map((item, index) => ({
                  title: item.title?.trim() || `Result ${index + 1}`,
                  url: item.url?.trim() || "",
                  snippet: item.description?.trim() || ""
                }));
                const result = {
                  provider: "brave",
                  fallbackFrom: "duckduckgo",
                  query,
                  count: rows.length,
                  country,
                  search_lang: searchLang,
                  ui_lang: uiLang,
                  freshness,
                  results: rows
                };
                setWebSearchCache(cacheKey, result);
                return toTextResult(result);
              }
              if (!tavilyApiKey) {
                return toTextResult({
                  ...baseFallbackError,
                  fallback: {
                    provider: "brave",
                    error: `web_search(brave) 请求失败: ${response.status}`
                  }
                });
              }
            }

            if (!tavilyApiKey) {
              return toTextResult({
                ...baseFallbackError,
                fallback: {
                  provider: "none",
                  error: "可选回退 provider 缺失 API Key（BRAVE_SEARCH_API_KEY / TAVILY_API_KEY）"
                }
              });
            }

            const tavilyTimeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, remainingBudgetMs()));
            const { response, payload } = await fetchJsonWithTimeout<{
              results?: Array<{ title?: string; url?: string; content?: string }>;
            }>(
              "https://api.tavily.com/search",
              tavilyTimeoutMs,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  Accept: "application/json"
                },
                body: JSON.stringify({
                  api_key: tavilyApiKey,
                  query,
                  max_results: count,
                  include_answer: false
                })
              }
            );
            if (!response.ok) {
              return toTextResult({
                ...baseFallbackError,
                fallback: {
                  provider: "tavily",
                  error: `web_search(tavily) 请求失败: ${response.status}`
                }
              });
            }
            const rows = (payload.results ?? []).slice(0, count).map((item, index) => ({
              title: item.title?.trim() || `Result ${index + 1}`,
              url: item.url?.trim() || "",
              snippet: item.content?.trim() || ""
            }));
            const result = {
              provider: "tavily",
              fallbackFrom: "duckduckgo",
              query,
              count: rows.length,
              results: rows
            };
            setWebSearchCache(cacheKey, result);
            return toTextResult(result);
          }

          if (provider === "brave") {
            if (!braveApiKey) {
              return toTextResult({
                error: "Brave provider 需要 braveApiKey 或环境变量 BRAVE_SEARCH_API_KEY",
                provider: "brave",
                query,
                results: []
              });
            }
            const braveUrl = new URL("https://api.search.brave.com/res/v1/web/search");
            braveUrl.searchParams.set("q", query);
            braveUrl.searchParams.set("count", String(count));
            if (country) braveUrl.searchParams.set("country", country);
            if (searchLang) braveUrl.searchParams.set("search_lang", searchLang);
            if (uiLang) braveUrl.searchParams.set("ui_lang", uiLang);
            if (freshness) braveUrl.searchParams.set("freshness", freshness);
            const requestTimeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, remainingBudgetMs()));
            const { response, payload } = await fetchJsonWithTimeout<{
              web?: {
                results?: Array<{ title?: string; url?: string; description?: string }>;
              };
            }>(braveUrl.toString(), requestTimeoutMs, {
              headers: {
                Accept: "application/json",
                "X-Subscription-Token": braveApiKey
              }
            });
            if (!response.ok) {
              return toTextResult({
                error: `web_search(brave) 请求失败: ${response.status}`,
                provider: "brave",
                query,
                results: []
              });
            }
            const rows = (payload.web?.results ?? []).slice(0, count).map((item, index) => ({
              title: item.title?.trim() || `Result ${index + 1}`,
              url: item.url?.trim() || "",
              snippet: item.description?.trim() || ""
            }));
            const result = {
              provider: "brave",
              query,
              count: rows.length,
              country,
              search_lang: searchLang,
              ui_lang: uiLang,
              freshness,
              results: rows
            };
            setWebSearchCache(cacheKey, result);
            return toTextResult(result);
          }

          if (provider === "tavily") {
            if (!tavilyApiKey) {
              return toTextResult({
                error: "Tavily provider 需要 tavilyApiKey 或环境变量 TAVILY_API_KEY",
                provider: "tavily",
                query,
                results: []
              });
            }
            const requestTimeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, remainingBudgetMs()));
            const { response, payload } = await fetchJsonWithTimeout<{
              results?: Array<{ title?: string; url?: string; content?: string }>;
            }>(
              "https://api.tavily.com/search",
              requestTimeoutMs,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  Accept: "application/json"
                },
                body: JSON.stringify({
                  api_key: tavilyApiKey,
                  query,
                  max_results: count,
                  include_answer: false
                })
              }
            );
            if (!response.ok) {
              return toTextResult({
                error: `web_search(tavily) 请求失败: ${response.status}`,
                provider: "tavily",
                query,
                results: []
              });
            }
            const rows = (payload.results ?? []).slice(0, count).map((item, index) => ({
              title: item.title?.trim() || `Result ${index + 1}`,
              url: item.url?.trim() || "",
              snippet: item.content?.trim() || ""
            }));
            const result = {
              provider: "tavily",
              query,
              count: rows.length,
              results: rows
            };
            setWebSearchCache(cacheKey, result);
            return toTextResult(result);
          }

          return toTextResult({
            error: `不支持的 provider: ${provider}`,
            provider,
            query,
            results: []
          });
        } catch (error) {
          return toTextResult({
            error: error instanceof Error ? error.message : String(error),
            provider,
            query,
            results: []
          });
        }
      }
    },
    {
      name: "web_fetch",
      label: "web_fetch",
      description: "Fetch a web page and return extracted text.",
      parameters: Type.Object({
        url: Type.String({ minLength: 1 }),
        extractMode: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("text")])),
        maxChars: Type.Optional(Type.Number({ minimum: 100 }))
      }),
      async execute(_toolCallId, args) {
        const params = (args ?? {}) as Record<string, unknown>;
        const rawUrl = typeof params.url === "string" ? params.url.trim() : "";
        if (!rawUrl) {
          return toTextResult({ error: "url 不能为空", url: rawUrl });
        }

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(rawUrl);
        } catch {
          return toTextResult({ error: `无效 URL: ${rawUrl}`, url: rawUrl });
        }
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          return toTextResult({ error: "仅支持 http/https URL", url: rawUrl });
        }
        if (isBlockedHost(parsedUrl.hostname)) {
          return toTextResult({ error: "出于安全策略，拒绝访问该主机", url: rawUrl });
        }

        const maxChars = clampInt(
          params.maxChars,
          100,
          MAX_WEB_FETCH_CHARS,
          DEFAULT_WEB_FETCH_MAX_CHARS
        );
        try {
          const response = await fetchWithTimeout(parsedUrl.toString(), DEFAULT_TIMEOUT_MS);
          const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
          const bodyText = await response.text();
          const extracted = contentType.includes("text/html")
            ? extractSimpleTextFromHtml(bodyText)
            : bodyText.trim();
          return toTextResult({
            url: parsedUrl.toString(),
            status: response.status,
            contentType,
            text: truncateText(extracted, maxChars),
            truncated: extracted.length > maxChars
          });
        } catch (error) {
          return toTextResult({
            url: parsedUrl.toString(),
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  ];
}
