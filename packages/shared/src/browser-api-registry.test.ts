import { describe, expect, test } from "bun:test"
import { BROWSER_API_REGISTRY, browserApiSupportForBackend } from "./browser-api-registry"

describe("browser API registry", () => {
  test("keeps API and backend handler declarations unique", () => {
    expect(new Set(BROWSER_API_REGISTRY.map((entry) => entry.api)).size).toBe(BROWSER_API_REGISTRY.length)
    expect(BROWSER_API_REGISTRY.every((entry) => entry.backends.length > 0 && entry.runtimeMethod.length > 0)).toBe(true)
  })

  test("fails closed and intersects extension declarations", () => {
    const unavailable = browserApiSupportForBackend("iab", new Set())
    expect(Object.values(unavailable).every((supported) => !supported)).toBe(true)

    const extension = browserApiSupportForBackend(
      "extension",
      new Set(["content", "browserAuth:request"]),
      { "Tab.content": true, "Tab.browserAuth": false },
    )
    expect(extension["Tab.content"]).toBe(true)
    expect(extension["Tab.browserAuth"]).toBe(false)
    expect(extension["DomCUAAPI.click"]).toBe(false)
  })
})
