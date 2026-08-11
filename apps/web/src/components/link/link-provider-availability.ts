import type { LinkRuntimeMode } from "@lume/shared";

// These providers cannot complete their main flow unless an external service
// can reach OpenConnector's callback URL.
const PUBLIC_CALLBACK_REQUIRED_SERVICES = new Set([
  "intercom",
  "sunoapi",
]);

export function isLinkProviderVisible(
  service: string,
  runtimeMode: LinkRuntimeMode,
  runtimeOrigin: string | null,
  configured: boolean,
): boolean {
  return configured || canCreateLinkConnection(service, runtimeMode, runtimeOrigin);
}

export function canCreateLinkConnection(
  service: string,
  runtimeMode: LinkRuntimeMode,
  runtimeOrigin: string | null,
): boolean {
  return !PUBLIC_CALLBACK_REQUIRED_SERVICES.has(service) || hasPublicCallbackOrigin(runtimeMode, runtimeOrigin);
}

export function canStartLinkConnectionFlow(
  service: string,
  runtimeMode: LinkRuntimeMode,
  runtimeOrigin: string | null,
  flowMode: "create" | "reconnect",
  authType?: string,
): boolean {
  return canCreateLinkConnection(service, runtimeMode, runtimeOrigin)
    || (flowMode === "reconnect" && authType !== "oauth2");
}

function hasPublicCallbackOrigin(runtimeMode: LinkRuntimeMode, runtimeOrigin: string | null): boolean {
  if (runtimeMode !== "remote" || !runtimeOrigin) return false;
  try {
    const hostname = new URL(runtimeOrigin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const ipv4 = parseIpv4(hostname);
    if (ipv4) return isPublicIpv4(ipv4);
    const ipv6 = parseIpv6(hostname);
    if (ipv6) return isPublicIpv6(ipv6);
    return isPlausiblyPublicHostname(hostname);
  } catch {
    return false;
  }
}

const INTERNAL_DNS_SUFFIXES = new Set([
  "alt", "arpa", "corp", "example", "home", "internal", "intranet", "invalid", "lan", "local", "localhost",
  "onion", "private", "test",
]);

function isPlausiblyPublicHostname(hostname: string): boolean {
  const labels = hostname.split(".");
  if (labels.length < 2 || labels.some((label) => !label)) return false;
  const topLevelDomain = labels.at(-1) ?? "";
  if (INTERNAL_DNS_SUFFIXES.has(topLevelDomain)) return false;
  return /^[a-z]{2,63}$/.test(topLevelDomain) || /^xn--[a-z0-9-]{2,59}$/.test(topLevelDomain);
}

function parseIpv4(hostname: string): number[] | null {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return null;
  const values = octets.map(Number);
  return values.every((value) => value >= 0 && value <= 255) ? values : null;
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseIpv6(hostname: string): number[] | null {
  let value = hostname;
  if (value.includes(".")) {
    const separator = value.lastIndexOf(":");
    const ipv4 = parseIpv4(value.slice(separator + 1));
    if (separator < 0 || !ipv4) return null;
    value = `${value.slice(0, separator)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = [...left, ...right];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  if (halves.length === 1) return groups.length === 8 ? groups.map((group) => parseInt(group, 16)) : null;
  const missing = 8 - groups.length;
  if (missing < 1) return null;
  return [...left.map((group) => parseInt(group, 16)), ...Array<number>(missing).fill(0), ...right.map((group) => parseInt(group, 16))];
}

function isPublicIpv6(groups: number[]): boolean {
  const first = groups[0];
  const allZeroPrefix = groups.slice(0, 6).every((group) => group === 0);
  if (groups.every((group) => group === 0) || (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1)) return false;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) return false;
  if (first === 0x2001 && groups[1] === 0x0db8) return false;
  if (allZeroPrefix || (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)) {
    return isPublicIpv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  return true;
}
