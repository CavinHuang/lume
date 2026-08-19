import assert from "node:assert/strict"
import test from "node:test"
import { isPublicAddress, parseProxyRoute, resolveGuardTarget } from "../src/browser-network-guard.ts"

test("network guard rejects private, reserved, link-local, and mixed DNS answers", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1"]) assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress("1.1.1.1"), true)
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true)
  await assert.rejects(() => resolveGuardTarget("example.test", 443, "https:", async () => [{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }]), /browser_network_blocked/)
})

test("network guard classifies ipv4-mapped, NAT64, and unspecified ipv6 literals by their embedded target", () => {
  for (const address of ["::ffff:a00:1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "::", "::1", "0.0.0.0", "ff02::1", "fe80::1", "fc00::1", "fd12::1"]) {
    assert.equal(isPublicAddress(address), false, address)
  }
  for (const address of ["::ffff:101:101", "::ffff:1.1.1.1", "64:ff9b::101:101", "2606:4700:4700::1111"]) {
    assert.equal(isPublicAddress(address), true, address)
  }
})

test("network guard permits only explicitly approved private origins", async () => {
  await assert.rejects(() => resolveGuardTarget("127.0.0.1", 3000, "http:", async () => []), /private_origin_confirmation_required/)
  assert.deepEqual(await resolveGuardTarget("127.0.0.1", 3000, "http:", async () => [], (origin) => origin === "http://127.0.0.1:3000"), { address: "127.0.0.1", family: 4, port: 3000 })
  assert.deepEqual(await resolveGuardTarget("localhost", 3000, "http:", async () => [{ address: "127.0.0.1", family: 4 }], (origin) => origin === "http://localhost:3000"), { address: "127.0.0.1", family: 4, port: 3000 })
  assert.deepEqual(await resolveGuardTarget("router.test", 443, "https:", async () => [{ address: "192.168.1.1", family: 4 }], (origin) => origin === "https://router.test"), { address: "192.168.1.1", family: 4, port: 443 })
})

test("network guard recognizes system proxy routes and only accepts fake DNS behind them", async () => {
  assert.deepEqual(parseProxyRoute("PROXY 127.0.0.1:7890; DIRECT"), { kind: "proxy", host: "127.0.0.1", port: 7890, secure: false })
  assert.deepEqual(parseProxyRoute("HTTPS proxy.example:8443"), { kind: "proxy", host: "proxy.example", port: 8443, secure: true })
  assert.deepEqual(parseProxyRoute("SOCKS5 127.0.0.1:1080; DIRECT"), { kind: "direct" })

  const fakeLookup = async () => [{ address: "198.18.0.203", family: 4 }]
  await assert.rejects(() => resolveGuardTarget("www.baidu.com", 443, "https:", fakeLookup), /browser_network_blocked/)
  assert.deepEqual(
    await resolveGuardTarget("www.baidu.com", 443, "https:", fakeLookup, undefined, true),
    { address: "198.18.0.203", family: 4, port: 443 },
  )
  await assert.rejects(
    () => resolveGuardTarget("internal.example", 443, "https:", async () => [{ address: "192.168.1.8", family: 4 }], undefined, true),
    /browser_network_blocked/,
  )
})
