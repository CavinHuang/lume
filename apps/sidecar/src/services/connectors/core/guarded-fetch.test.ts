import { describe, expect, test } from "bun:test";
import { assertPublicHttpUrl, classifyIpAddress, isBlockedIpAddress } from "./request";
import { createGuardedFetch, type GuardedFetchDnsLookup } from "./guarded-fetch";

const failFast = (message: string) => new TypeError(message);

describe("classifyIpAddress egress matrix", () => {
  const cases: Array<[string, ReturnType<typeof classifyIpAddress>]> = [
    // always-blocked: loopback / link-local / metadata / special-use
    ["0.0.0.0", "always-blocked"],
    ["127.0.0.1", "always-blocked"],
    ["169.254.169.254", "always-blocked"], // AWS/GCP metadata
    ["100.100.100.200", "always-blocked"], // Alibaba metadata(CGNAT 内钉死)
    ["224.0.0.1", "always-blocked"], // multicast
    ["240.0.0.1", "always-blocked"], // future-use
    ["192.0.2.1", "always-blocked"], // documentation
    ["::", "always-blocked"],
    ["::1", "always-blocked"],
    ["fe80::1", "always-blocked"], // link-local
    ["fd00:ec2::254", "always-blocked"], // IMDSv2 IPv6
    ["ff02::1", "always-blocked"], // multicast
    // private(默认拒,opt-in 可放行)
    ["10.0.0.1", "private"],
    ["172.16.0.5", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"], // CGNAT
    ["fc00::1", "private"],
    // vpn-mapped
    ["198.18.0.1", "vpn-mapped"],
    // public
    ["8.8.8.8", "public"],
    ["2606:4700::1111", "public"],
    // 嵌入式 IPv4 继承分类
    ["::ffff:127.0.0.1", "always-blocked"],
    ["::ffff:8.8.8.8", "public"],
  ];

  for (const [address, expected] of cases) {
    test(`${address} → ${expected}`, () => {
      expect(classifyIpAddress(address)).toBe(expected);
    });
  }

  test("无法解析的输入 fail closed", () => {
    expect(classifyIpAddress("not-an-ip")).toBe("always-blocked");
  });

  test("isBlockedIpAddress: opt-in 放行 private 但永不放行 reserved", () => {
    expect(isBlockedIpAddress("192.168.1.1", false)).toBe(true);
    expect(isBlockedIpAddress("192.168.1.1", true)).toBe(false);
    expect(isBlockedIpAddress("127.0.0.1", true)).toBe(true);
    expect(isBlockedIpAddress("169.254.169.254", true)).toBe(true);
  });
});

describe("assertPublicHttpUrl literal guards", () => {
  const blocked = [
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/x",
    "http://foo.localhost/x",
    "http://metadata.google.internal/computeMetadata/v1/",
    "ftp://example.com/file",
  ];
  for (const url of blocked) {
    test(`拒绝 ${url}`, () => {
      expect(() => assertPublicHttpUrl(url, { fieldName: "test", createError: failFast })).toThrow();
    });
  }

  test("放行公网 https URL", () => {
    expect(
      assertPublicHttpUrl("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
        fieldName: "test",
        createError: failFast,
      }),
    ).toBeDefined();
  });
});

describe("createGuardedFetch hop guards", () => {
  const publicLookup: GuardedFetchDnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const metadataLookup: GuardedFetchDnsLookup = async () => [{ address: "169.254.169.254", family: 4 }];
  const failingLookup: GuardedFetchDnsLookup = async () => {
    throw new Error("resolver down");
  };

  // Bun 的 fetch 类型带 preconnect 方法,无状态 stub 需断言抹平
  const unreachable = async () => new Response("should not reach") as unknown as Response;

  test("解析到 metadata 地址的 hostname 被拒", async () => {
    const fetcher = createGuardedFetch({ fetch: unreachable as unknown as typeof fetch, lookup: metadataLookup });
    await expect(fetcher("https://evil.example.com/steal")).rejects.toThrow(/169\.254|blocked|private/i);
  });

  test("DNS 解析失败 fail closed", async () => {
    const fetcher = createGuardedFetch({ fetch: unreachable as unknown as typeof fetch, lookup: failingLookup });
    await expect(fetcher("https://evil.example.com/")).rejects.toThrow();
  });

  test("重定向跳进 metadata 端点被逐跳拦截", async () => {
    let transportCalls = 0;
    const fetcher = createGuardedFetch({
      lookup: publicLookup,
      fetch: (async () => {
        transportCalls += 1;
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      }) as unknown as typeof fetch,
    });
    await expect(fetcher("https://evil.example.com/redirect")).rejects.toThrow();
    // 第一跳已发出,第二跳目标在 guard 处终止,不会到达 metadata
    expect(transportCalls).toBe(1);
  });

  test("跨域重定向剥离凭证头", async () => {
    const seenHeaders: string[] = [];
    const responses = [
      new Response(null, { status: 302, headers: { location: "https://other.example.com/final" } }),
      new Response("ok", { status: 200 }),
    ];
    let call = 0;
    const fetcher = createGuardedFetch({
      lookup: publicLookup,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seenHeaders.push(headers.get("authorization") ?? "(none)");
        return responses[Math.min(call++, responses.length - 1)] as Response;
      }) as unknown as typeof fetch,
    });
    const response = await fetcher("https://evil.example.com/start", { headers: { authorization: "Bearer secret" } });
    expect(response.status).toBe(200);
    expect(seenHeaders[0]).toBe("Bearer secret"); // 首跳携带凭证
    expect(seenHeaders[1]).toBe("(none)"); // 跨域跳转后剥离
  });

  test("allowPrivateNetwork=true 时 loopback/metadata 仍被拦", async () => {
    const fetcher = createGuardedFetch({
      allowPrivateNetwork: true,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      fetch: unreachable as unknown as typeof fetch,
    });
    await expect(fetcher("https://internal.example.com/")).rejects.toThrow();
  });
});
