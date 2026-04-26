import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getActiveProxyConfig } from "../system/proxy-settings-manager";

const execFileAsync = promisify(execFile);
const STATUS_SENTINEL = "__LUME_STATUS__:";

export function shouldBypassProxy(targetUrl: string, noProxy?: string): boolean {
  const hostname = new URL(targetUrl).hostname.toLowerCase();
  const rules = (noProxy ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return rules.some((rule) => {
    if (rule === "*") {
      return true;
    }
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(2);
      return hostname === suffix || hostname.endsWith(`.${suffix}`);
    }
    return hostname === rule || hostname.endsWith(`.${rule}`);
  });
}

function resolveProxyUrl(targetUrl: string): string | null {
  const config = getActiveProxyConfig();
  if (!config.enabled || config.mode === "off") {
    return null;
  }
  if (shouldBypassProxy(targetUrl, config.noProxy)) {
    return null;
  }
  const protocol = new URL(targetUrl).protocol;
  if (protocol === "https:") {
    return config.httpsProxy ?? config.httpProxy ?? null;
  }
  return config.httpProxy ?? null;
}

async function fetchViaCurl(input: string, init: RequestInit = {}, proxyUrl: string): Promise<Response> {
  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--max-time",
    "20",
    "--connect-timeout",
    "12",
    "--proxy",
    proxyUrl,
    "--request",
    init.method ?? "GET",
    input
  ];

  const headers = new Headers(init.headers);
  headers.forEach((value, key) => {
    args.push("--header", `${key}: ${value}`);
  });

  if (typeof init.body === "string") {
    args.push("--data-raw", init.body);
  }

  args.push("--write-out", `\n${STATUS_SENTINEL}%{http_code}`);

  const { stdout, stderr } = await execFileAsync(process.platform === "win32" ? "curl.exe" : "curl", args, {
    maxBuffer: 1024 * 1024 * 4
  });
  const output = stdout.toString();
  const markerIndex = output.lastIndexOf(STATUS_SENTINEL);
  if (markerIndex < 0) {
    throw new Error(stderr?.toString().trim() || "curl 返回异常");
  }
  const body = output.slice(0, markerIndex);
  const statusText = output.slice(markerIndex + STATUS_SENTINEL.length).trim();
  const status = Number.parseInt(statusText, 10);
  return new Response(body, {
    status: Number.isFinite(status) ? status : 599,
    headers: {
      "content-type": headers.get("content-type") ?? "text/plain; charset=utf-8"
    }
  });
}

export async function fetchWithProxy(input: string, init?: RequestInit): Promise<Response> {
  const proxyUrl = resolveProxyUrl(input);
  if (proxyUrl) {
    return fetchViaCurl(input, init, proxyUrl);
  }
  return fetch(input, init);
}
