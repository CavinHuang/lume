import { describe, expect, it } from "bun:test";
import { ProxyAgent } from "undici";
import { createPinnedLookup, isProxyLikeDispatcher } from "./guarded-fetch";

describe("isProxyLikeDispatcher", () => {
  it("detects a globally installed proxy dispatcher by class identity", () => {
    const proxy = new ProxyAgent("http://127.0.0.1:1");
    // 代理接管连接层时禁止 per-request pinned 覆写(否则 connector 出站静默绕开用户代理)
    expect(isProxyLikeDispatcher(proxy, [ProxyAgent])).toBe(true);
    // 直连默认态(全局为普通 Agent/undefined)保持 pinning
    expect(isProxyLikeDispatcher(undefined, [ProxyAgent])).toBe(false);
    expect(isProxyLikeDispatcher({}, [ProxyAgent])).toBe(false);
  });

  it("tolerates missing proxy classes (older undici exports)", () => {
    const lookup = createPinnedLookup([{ address: "93.184.216.34", family: 4 }]);
    expect(typeof lookup).toBe("function");
    expect(isProxyLikeDispatcher({ constructor: Object }, [])).toBe(false);
  });
});

type LookupCallback = (error: Error | null, addresses?: Array<{ address: string; family: number }>) => void;

describe("createPinnedLookup", () => {
  it("answers from the screened set with round-robin failover", async () => {
    const lookup = createPinnedLookup([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);

    const seen: Array<{ address: string; family: number }> = [];
    const run = () =>
      new Promise<void>((resolve, reject) => {
        // undici 7 connect.lookup 期望 all:true 数组形制回调
        const callback: LookupCallback = (error, answers) => {
          if (error) reject(error);
          else {
            seen.push(answers![0]!);
            resolve();
          }
        };
        (lookup as unknown as (...args: unknown[]) => void)("example.com", {}, callback);
      });

    await Promise.all([run(), run(), run()]);
    expect(seen.map((entry) => entry.address)).toEqual([
      "93.184.216.34",
      "2606:2800:220:1:248:1893:25c8:1946",
      "93.184.216.34",
    ]);
    expect(seen[0]!.family).toBe(4);
    expect(seen[1]!.family).toBe(6);
  });

  it("fails closed on an empty screened set", async () => {
    const lookup = createPinnedLookup([]);
    await new Promise<void>((resolve) => {
      const callback: LookupCallback = (error) => {
        expect(error?.message).toContain("no screened addresses");
        resolve();
      };
      (lookup as unknown as (...args: unknown[]) => void)("example.com", {}, callback);
    });
  });
});
