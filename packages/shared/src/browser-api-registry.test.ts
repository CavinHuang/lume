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

    const iab = browserApiSupportForBackend("iab", new Set(["claim", "mark"]))
    expect(iab["BrowserUser.claimTab"]).toBe(true)
    expect(iab["Tab.markDeliverable"]).toBe(true)
    expect(iab["Tab.markHandoff"]).toBe(true)

    const extension = browserApiSupportForBackend(
      "extension",
      new Set(["content:export", "browserAuth:request", "nameSession", "dom:click"]),
      { "Tab.content": true, "ContentAPI.export": true, "Tab.browserAuth": false, "Browser.nameSession": true, "DomCUAAPI.click": true },
    )
    expect(extension["Tab.content"]).toBe(true)
    expect(extension["ContentAPI.export"]).toBe(true)
    expect(extension["ContentAPI.exportGsuite"]).toBe(false)
    expect(extension["Tab.browserAuth"]).toBe(false)
    expect(extension["Browser.nameSession"]).toBe(true)
    expect(extension["DomCUAAPI.click"]).toBe(true)
  })
})
