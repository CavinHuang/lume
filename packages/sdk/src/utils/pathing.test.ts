import { describe, expect, test } from "bun:test"
import { isFakeIpRange } from "./pathing.js"

describe("isFakeIpRange", () => {
  test("matches the 198.18.0.0/15 fake-IP benchmark range", () => {
    expect(isFakeIpRange("198.18.0.1")).toBe(true)
    expect(isFakeIpRange("198.19.255.254")).toBe(true)
  })

  test("rejects adjacent and unrelated ranges", () => {
    expect(isFakeIpRange("198.17.0.1")).toBe(false)
    expect(isFakeIpRange("198.20.0.1")).toBe(false)
    expect(isFakeIpRange("10.0.0.1")).toBe(false)
    expect(isFakeIpRange("::1")).toBe(false)
    expect(isFakeIpRange("not-an-ip")).toBe(false)
  })
})
