import type { ChatToolTestResult } from "@lume/shared";
import { fetchWithProxy } from "../infra/proxy-fetch";

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

function decodeDuckDuckGoRedirectUrl(rawUrl: string): string {
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

function parseDuckDuckGoResults(
  html: string,
  maxResults: number
): Array<{ title: string; url: string; snippet: string }> {
  const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi;

  const links: Array<{ title: string; url: string }> = [];
  const snippets: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) && links.length < maxResults + 2) {
    links.push({
      url: decodeDuckDuckGoRedirectUrl(match[1] ?? ""),
      title: stripHtmlTags(match[2] ?? "")
    });
  }

  while ((match = snippetRegex.exec(html)) && snippets.length < maxResults + 2) {
    snippets.push(stripHtmlTags(match[1] ?? ""));
  }

  return links.slice(0, maxResults).map((item, index) => ({
    title: item.title || `Result ${index + 1}`,
    url: item.url,
    snippet: snippets[index] ?? ""
  }));
}

async function searchWebByDuckDuckGo(query: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchWithProxy(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "user-agent": "Lume-Chat/1.0 (+web_search)"
      }
    });
    if (!response.ok) {
      throw new Error(`web_search 请求失败: ${response.status}`);
    }
    const html = await response.text();
    const results = parseDuckDuckGoResults(html, 5);
    if (results.length === 0) {
      return "未检索到可用搜索结果。";
    }
    return results
      .map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.snippet}`.trim())
      .join("\n\n");
  } finally {
    clearTimeout(timer);
  }
}

async function searchWebByBrave(query: string, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchWithProxy(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "x-subscription-token": apiKey,
        accept: "application/json",
        "user-agent": "Lume-Chat/1.0 (+web_search)"
      }
    });
    if (!response.ok) {
      throw new Error(`web_search(brave) 请求失败: ${response.status}`);
    }
    const payload = await response.json() as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const items = payload.web?.results?.slice(0, 5) ?? [];
    if (items.length === 0) {
      return "未检索到可用搜索结果。";
    }
    return items
      .map((item, index) => `${index + 1}. ${item.title ?? "Untitled"}\n${item.url ?? ""}\n${item.description ?? ""}`.trim())
      .join("\n\n");
  } finally {
    clearTimeout(timer);
  }
}

async function searchWebByTavily(query: string, apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchWithProxy("https://api.tavily.com/search", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "Lume-Chat/1.0 (+web_search)"
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: 5
      })
    });
    if (!response.ok) {
      throw new Error(`web_search(tavily) 请求失败: ${response.status}`);
    }
    const payload = await response.json() as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const items = payload.results?.slice(0, 5) ?? [];
    if (items.length === 0) {
      return "未检索到可用搜索结果。";
    }
    return items
      .map((item, index) => `${index + 1}. ${item.title ?? "Untitled"}\n${item.url ?? ""}\n${item.content ?? ""}`.trim())
      .join("\n\n");
  } finally {
    clearTimeout(timer);
  }
}

export function shouldRunWebSearch(userMessage: string): boolean {
  return /\b(latest|today|current|news|price|weather|score|release|update)\b|最新|今天|现在|新闻|价格|汇率|天气|比分|发布|更新/iu.test(userMessage);
}

export async function searchWeb(
  query: string,
  credentials?: Record<string, string>
): Promise<{ provider: "duckduckgo" | "brave" | "tavily"; result: string }> {
  const braveApiKey = credentials?.braveApiKey?.trim();
  const tavilyApiKey = credentials?.tavilyApiKey?.trim();

  const attempts: Array<{
    provider: "duckduckgo" | "brave" | "tavily";
    run: () => Promise<string>;
  }> = [];

  if (braveApiKey) {
    attempts.push({ provider: "brave", run: () => searchWebByBrave(query, braveApiKey) });
  }
  if (tavilyApiKey) {
    attempts.push({ provider: "tavily", run: () => searchWebByTavily(query, tavilyApiKey) });
  }
  attempts.push({ provider: "duckduckgo", run: () => searchWebByDuckDuckGo(query) });

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return { provider: attempt.provider, result: await attempt.run() };
    } catch (error) {
      lastError = error;
    }
  }

  throw (lastError ?? new Error("web_search 未命中可用 provider"));
}

export async function testWebSearchConnection(credentials: Record<string, string>): Promise<ChatToolTestResult> {
  const braveApiKey = credentials.braveApiKey?.trim();
  const tavilyApiKey = credentials.tavilyApiKey?.trim();

  if (braveApiKey) {
    try {
      await searchWebByBrave("test connection", braveApiKey);
      return { success: true, message: "连接成功，Brave Search API 可用" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message: `Brave 连接失败: ${message}` };
    }
  }

  if (tavilyApiKey) {
    try {
      await searchWebByTavily("test connection", tavilyApiKey);
      return { success: true, message: "连接成功，Tavily Search API 可用" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message: `Tavily 连接失败: ${message}` };
    }
  }

  try {
    await searchWebByDuckDuckGo("test connection");
    return { success: true, message: "连接成功，DuckDuckGo 可用" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `DuckDuckGo 连接失败: ${message}` };
  }
}
