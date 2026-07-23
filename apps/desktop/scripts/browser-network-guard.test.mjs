import assert from "node:assert/strict"
import test from "node:test"
import { isPublicAddress, resolveGuardTarget } from "../src/browser-network-guard.ts"

test("network guard rejects private, reserved, link-local, and mixed DNS answers", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1"]) assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress("1.1.1.1"), true)
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true)
  await assert.rejects(() => resolveGuardTarget("example.test", 443, "https:", async () => [{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }]), /browser_network_blocked/)
})

test("network guard permits only explicitly approved private origins", async () => {
  await assert.rejects(() => resolveGuardTarget("127.0.0.1", 3000, "http:", async () => []), /private_origin_confirmation_required/)
  assert.deepEqual(await resolveGuardTarget("127.0.0.1", 3000, "http:", async () => [], (origin) => origin === "http://127.0.0.1:3000"), { address: "127.0.0.1", family: 4, port: 3000 })
  assert.deepEqual(await resolveGuardTarget("localhost", 3000, "http:", async () => [{ address: "127.0.0.1", family: 4 }], (origin) => origin === "http://localhost:3000"), { address: "127.0.0.1", family: 4, port: 3000 })
  assert.deepEqual(await resolveGuardTarget("router.test", 443, "https:", async () => [{ address: "192.168.1.1", family: 4 }], (origin) => origin === "https://router.test"), { address: "192.168.1.1", family: 4, port: 443 })
})
