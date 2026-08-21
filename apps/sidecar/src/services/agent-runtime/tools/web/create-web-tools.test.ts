import { describe, expect, test } from "bun:test";
import { checkPublicWebHost } from "./create-web-tools";

describe("checkPublicWebHost", () => {
  test("allows public IPv4 literal", async () => {
    expect(await checkPublicWebHost("https://8.8.8.8/dns")).toBeNull();
  });

  test("denies loopback and link-local metadata endpoints", async () => {
    expect(await checkPublicWebHost("http://127.0.0.1:8080/")).toContain("sandbox denied");
    expect(await checkPublicWebHost("http://169.254.169.254/latest/meta-data")).toContain("sandbox denied");
  });

  test("denies private ranges and IPv6 loopback", async () => {
    expect(await checkPublicWebHost("http://10.1.2.3/")).toContain("sandbox denied");
    expect(await checkPublicWebHost("http://192.168.1.1/")).toContain("sandbox denied");
    expect(await checkPublicWebHost("http://[::1]/")).toContain("sandbox denied");
  });

  test("denies malformed URLs", async () => {
    expect(await checkPublicWebHost("not-a-url")).toContain("Invalid URL");
  });

  // fake-IP 豁免只作用于 DNS 解析分支；URL 字面直写 fake-IP 段仍是探测行为，必须拦截
  test("denies fake-IP range written as a literal IP", async () => {
    expect(await checkPublicWebHost("http://198.18.0.1/")).toContain("sandbox denied");
    expect(await checkPublicWebHost("http://198.19.1.1/")).toContain("sandbox denied");
  });
});
