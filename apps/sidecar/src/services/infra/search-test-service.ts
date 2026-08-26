import type { TestSearchBackendInput, TestSearchBackendResult } from "@lume/shared";
import { fetchWithProxy } from "./proxy-fetch";

export async function testSearchBackend(
  input: TestSearchBackendInput
): Promise<TestSearchBackendResult> {
  const { provider, apiKey } = input;
  try {
    switch (provider) {
      case "exa":
        return await testExa(apiKey);
      case "tavily":
        return await testTavily(apiKey);
      case "brave":
        return await testBrave(apiKey);
      case "pipellm":
        return await testPipellm(apiKey);
      case "zhipu":
        return await testZhipu(apiKey);
      case "duckduckgo":
        return await testDuckDuckGo();
      case "bing":
        return await testBing();
      default:
        return { ok: false, provider, error: "未知搜索后端" };
    }
  } catch (error) {
    return {
      ok: false,
      provider,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function testExa(apiKey?: string): Promise<TestSearchBackendResult> {
  if (!apiKey) return { ok: false, provider: "exa", error: "请先填写 API Key" };
  const response = await fetchWithProxy("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ query: "test", type: "auto", numResults: 1 }),
    signal: AbortSignal.timeout(10000)
  });
  return { ok: response.ok, provider: "exa", ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
}

async function testTavily(apiKey?: string): Promise<TestSearchBackendResult> {
  if (!apiKey) return { ok: false, provider: "tavily", error: "请先填写 API Key" };
  const response = await fetchWithProxy("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query: "test", max_results: 1 }),
    signal: AbortSignal.timeout(10000)
  });
  return { ok: response.ok, provider: "tavily", ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
}

async function testBrave(apiKey?: string): Promise<TestSearchBackendResult> {
  if (!apiKey) return { ok: false, provider: "brave", error: "请先填写 API Key" };
  const response = await fetchWithProxy("https://api.search.brave.com/res/v1/web/search?q=test&count=1", {
    headers: { "x-subscription-token": apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  return { ok: response.ok, provider: "brave", ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
}

async function testPipellm(apiKey?: string): Promise<TestSearchBackendResult> {
  if (!apiKey) return { ok: false, provider: "pipellm", error: "请先填写 API Key" };
  const response = await fetchWithProxy("https://api.pipellm.com/v1/search", {
    method: "POST",
    headers: { "authorization": `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "test", max_results: 1 }),
    signal: AbortSignal.timeout(10000)
  });
  return { ok: response.ok, provider: "pipellm", ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
}

async function testZhipu(apiKey?: string): Promise<TestSearchBackendResult> {
  if (!apiKey) return { ok: false, provider: "zhipu", error: "请先填写 API Key" };
  const response = await fetchWithProxy("https://open.bigmodel.cn/api/paas/v4/web_search", {
    method: "POST",
    headers: { "authorization": `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "test", count: 1 }),
    signal: AbortSignal.timeout(10000)
  });
  return { ok: response.ok, provider: "zhipu", ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
}

async function testDuckDuckGo(): Promise<TestSearchBackendResult> {
  const response = await fetchWithProxy("https://html.duckduckgo.com/html/?q=test", {
    signal: AbortSignal.timeout(10000)
  });
  return { ok: response.ok, provider: "duckduckgo", ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
}

async function testBing(): Promise<TestSearchBackendResult> {
  const response = await fetchWithProxy("https://www.bing.com/search?q=test", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    },
    signal: AbortSignal.timeout(10000)
  });
  return { ok: response.ok, provider: "bing", ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
}
