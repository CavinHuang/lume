import {
  GuanlanHotnewsTool,
  GuanlanReadTool,
  GuanlanResearchTool,
  GuanlanSearchTool,
  WebFetchTool,
  WebSearchTool,
  defineTool,
  fetchIdFromUrl,
  runWebFetch,
  sdkFetch,
  type FetchImpl,
  type RenderClient,
  type ToolDefinition
} from "@lume/agent-sdk";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { getWorkspaceResourcesPath } from "../../../infra/config-paths";
import { isFakeIpRange, isPublicIpAddress } from "@lume/agent-sdk";

export const WEB_TOOL_NAMES = [
  "WebSearch",
  "WebFetch",
  "guanlan_search",
  "guanlan_read",
  "guanlan_hotnews",
  "guanlan_research"
] as const;

export interface CreateSdkWebToolsInput {
  /** Per-session workspace slug; enables on-disk asset persistence for WebFetch. */
  workspaceSlug?: string;
  /** Reverse-RPC client to the desktop renderer; enables JS-rendered fetches. */
  renderClient?: RenderClient;
}

// 代理环境跳过私网判定：sdkFetch 在代理下走 curl --proxy，代理侧 split-DNS 与本机不同，
// 经代理访问内网是常见合法配置，本机 DNS 判定会误杀。
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;
const hasProxyEnvironment = PROXY_ENV_KEYS.some((key) => Boolean(process.env[key]?.trim()));

/**
 * 校验 URL 目标主机解析到的全部地址均为公网地址（防 SSRF 探测内网/云元数据端点）。
 * 返回拒绝原因，放行时为 null。
 * 已知天花板：check-then-fetch 无法防 DNS rebinding（undici 会重新解析）；
 * 固定 IP 连接（如 infra 的 SafeHttpFetchService）是升级路径。
 * fake-IP 豁免：TUN 代理下 DNS 全量返回 198.18.0.0/15 虚拟映射（不指向真实内网），
 * 该段在 DNS 判定中按公网放行；URL 字面 IP 直写该段仍由 SDK ensureNetworkAllowed 拦截。
 */
export async function checkPublicWebHost(url: string): Promise<string | null> {
  if (hasProxyEnvironment) return null;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return `Invalid URL: ${url}`;
  }
  // Node 的 URL.hostname 对 IPv6 保留方括号（"[::1]"），剥掉再判
  const bare = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!bare) return `Invalid URL: ${url}`;
  let addresses: string[] | null;
  if (isIP(bare)) {
    addresses = [bare];
  } else {
    // DNS 解析失败按拒绝处理（fail closed），不让异常逃逸到 fetch 调用链
    addresses = await lookup(bare, { all: true, verbatim: true })
      .then((items) => items.map((item) => item.address))
      .catch(() => null);
  }
  // URL 字面 IP 直写 fake-IP 段仍是探测行为，照拦；仅 DNS 解析结果豁免（TUN 代理虚拟映射不指向真实内网）
  if (isIP(bare)) {
    if (!isPublicIpAddress(bare)) return `sandbox denied network access to ${bare}`;
  } else if (!addresses || addresses.length === 0
    || addresses.some((address) => !isPublicIpAddress(address) && !isFakeIpRange(address))) {
    return `sandbox denied network access to ${bare}`;
  }
  return null;
}

async function assertPublicWebHost(url: string): Promise<void> {
  const denied = await checkPublicWebHost(url);
  if (denied) throw new Error(denied);
}

function createPrivateNetworkGuardedFetch(): FetchImpl {
  return async (url, init) => {
    await assertPublicWebHost(String(url));
    return sdkFetch(String(url), init);
  };
}

/** renderClient（renderer Chromium 导航）不经 fetchImpl，包装 renderUrl 对请求与 finalUrl 补私网判定；拒绝按 RenderFailure 返回。 */
function createGuardedRenderClient(client: RenderClient): RenderClient {
  return {
    async renderUrl(url, options) {
      const denied = await checkPublicWebHost(url);
      if (denied) return { ok: false, error: { code: "sandbox_network_denied", message: denied } };
      const outcome = await client.renderUrl(url, options);
      if (outcome.ok) {
        const finalDenied = await checkPublicWebHost(outcome.finalUrl);
        if (finalDenied) return { ok: false, error: { code: "sandbox_network_denied", message: finalDenied } };
      }
      return outcome;
    }
  };
}

/**
 * Build the SDK web toolset. WebFetch is wrapped so the sidecar can inject a
 * renderClient (reverse-RPC bridge to the desktop PageRenderer) and an asset
 * dir resolver keyed off the workspace slug. When neither is supplied the tool
 * behaves exactly like the stock SDK WebFetch (static fetch, no asset write).
 *
 * 安全收口（工具层内网防护）：普通线程无 sandbox.network 配置，SDK 的
 * ensureNetworkAllowed 恒放行；这里注入经私网判定的 fetchImpl 与 renderClient 包装。
 * 已知未覆盖面：trafilatura/lynx reader 本地子进程直抓 URL（URL 已过静态校验，
 * 仅剩 TOCTOU），与 DNS rebinding 同属天花板项。
 */
export function createSdkWebTools(input: CreateSdkWebToolsInput = {}): ToolDefinition[] {
  return [
    WebSearchTool,
    createEnhancedWebFetch(input),
    GuanlanSearchTool,
    GuanlanReadTool,
    GuanlanHotnewsTool,
    GuanlanResearchTool
  ];
}

function createEnhancedWebFetch(input: CreateSdkWebToolsInput): ToolDefinition {
  const { workspaceSlug, renderClient } = input;
  return defineTool({
    name: "WebFetch",
    description: WebFetchTool.description ?? "Fetch a URL as Markdown.",
    inputSchema: WebFetchTool.inputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    async call(toolInput, context) {
      return runWebFetch(toolInput, context, {
        renderClient: renderClient ? createGuardedRenderClient(renderClient) : undefined,
        fetchImpl: createPrivateNetworkGuardedFetch(),
        resolveAssetDir: workspaceSlug
          ? (url) => join(getWorkspaceResourcesPath(workspaceSlug), "fetches", fetchIdFromUrl(url))
          : undefined
      });
    }
  });
}
