import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isPublicIpAddress } from "@lume/agent-sdk";

export interface WikiSafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Uint8Array;
}

export interface WikiSafeHttpFetchOptions {
  maxRedirects?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxBytes?: number;
  /**
   * 代理环境策略：fail-closed（默认，wiki 语义——本服务直连不走代理，代理环境下拒绝抓取）
   * 或 ignore（调用方明确接受直连语义，如 IM 媒体下载——Node fetch 本就不走代理环境变量）。
   */
  proxyPolicy?: "fail-closed" | "ignore";
}

interface LookupAddress { address: string; family: 4 | 6 }
type Resolver = (hostname: string) => Promise<LookupAddress[]>;
type Requester = (url: URL, address: LookupAddress, options: { connectTimeoutMs: number; totalTimeoutMs: number; maxBytes: number }) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Uint8Array }>;

export class WikiSafeHttpFetchService {
  constructor(private readonly deps: { resolve?: Resolver; request?: Requester } = {}) {}

  async fetch(rawUrl: string, options: WikiSafeHttpFetchOptions = {}): Promise<WikiSafeFetchResult> {
    if (options.proxyPolicy !== "ignore" && hasProxyEnvironment()) throw new Error("Wiki URL 导入在代理环境中 fail closed；请先用 WebFetch 保存本地资产再导入");
    const maxRedirects = options.maxRedirects ?? 5;
    const requestOptions = {
      connectTimeoutMs: options.connectTimeoutMs ?? 8_000,
      totalTimeoutMs: options.totalTimeoutMs ?? 30_000,
      maxBytes: options.maxBytes ?? 25 * 1024 * 1024
    };
    let current = normalizeUrl(rawUrl);
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const addresses = await (this.deps.resolve ?? resolvePublicAddresses)(current.hostname);
      if (addresses.length === 0 || addresses.some((address) => !isPublicIpAddress(address.address))) throw new Error("Wiki URL DNS 结果包含非公网或混合地址");
      const selected = addresses[0]!;
      const response = await (this.deps.request ?? requestFixedAddress)(current, selected, requestOptions);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = firstHeader(response.headers.location);
        if (!location) throw new Error("Wiki URL 重定向缺少 Location");
        if (redirect === maxRedirects) throw new Error("Wiki URL 重定向次数超限");
        current = normalizeUrl(new URL(location, current).toString());
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`Wiki URL 请求失败: HTTP ${response.status}`);
      return { finalUrl: current.toString(), status: response.status, contentType: firstHeader(response.headers["content-type"]) ?? "application/octet-stream", body: response.body };
    }
    throw new Error("Wiki URL 重定向失败");
  }
}

function normalizeUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Wiki URL 仅允许 http/https");
  if (url.username || url.password) throw new Error("Wiki URL 不允许 credentials");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if ((url.protocol === "https:" && port !== 443) || (url.protocol === "http:" && port !== 80)) throw new Error("Wiki URL 首版仅允许标准端口");
  return url;
}

async function resolvePublicAddresses(hostname: string): Promise<LookupAddress[]> {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((item) => ({ address: item.address, family: item.family === 6 ? 6 : 4 }));
}

function requestFixedAddress(url: URL, address: LookupAddress, limits: { connectTimeoutMs: number; totalTimeoutMs: number; maxBytes: number }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.protocol === "https:" ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { Host: url.host, Accept: "text/html,text/plain,application/json;q=0.8,*/*;q=0.2", "User-Agent": "Lume-Wiki/1" },
      servername: url.hostname,
      lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => callback(null, address.address, address.family)) as RequestOptions["lookup"]
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limits.maxBytes) {
          request.destroy(new Error("Wiki URL 响应超过大小限制"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(limits.connectTimeoutMs, () => request.destroy(new Error("Wiki URL 连接超时")));
    const total = setTimeout(() => request.destroy(new Error("Wiki URL 总超时")), limits.totalTimeoutMs);
    total.unref();
    request.once("close", () => clearTimeout(total));
    request.once("error", reject);
    request.end();
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hasProxyEnvironment(): boolean {
  return ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some((key) => Boolean(process.env[key]?.trim()));
}

// 公网判定单源移入 @lume/agent-sdk（scraper 私网拦截共用），此处保留转发导出
export { isPublicIpAddress };
