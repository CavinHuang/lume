import { describe, expect, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ThreadFileEnvProvider, useThreadFileEnv } from "./thread-file-env"

function Consumer(): string {
  const env = useThreadFileEnv()
  return JSON.stringify(env)
}

describe("thread-file-env", () => {
  test("default env is empty when no provider", () => {
    const markup = renderToStaticMarkup(<Consumer />)
    expect(JSON.parse(markup)).toEqual({})
  })

  test("provides env value to consumer", () => {
    const markup = renderToStaticMarkup(
      <ThreadFileEnvProvider value={{ threadId: "t1", workspaceSlug: "ws-1" }}>
        <Consumer />
      </ThreadFileEnvProvider>,
    )
    // SSR escapes JSON text nodes; unescape before parsing
    const parsed = JSON.parse(markup.replace(/&quot;/g, '"'))
    expect(parsed).toEqual({ threadId: "t1", workspaceSlug: "ws-1" })
  })
})
