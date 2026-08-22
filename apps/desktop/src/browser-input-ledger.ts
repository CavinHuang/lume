type ExpectedInput = {
  button?: string
  expiresAt: number
  key?: string
  kind: "key" | "mouse"
  type: string
}

export class BrowserInputLedger {
  private readonly entries = new Map<string, ExpectedInput[]>()

  constructor(private readonly now: () => number = Date.now) {}

  expectCommand(tabId: string, method: string, params: Record<string, unknown> = {}): void {
    const expiresAt = this.now() + 500
    const expected = commandInputs(method, params, expiresAt)
    if (!expected.length) return
    this.entries.set(tabId, [...this.current(tabId), ...expected].slice(-64))
  }

  consumeKey(tabId: string, input: { type: string; key: string }): boolean {
    return this.consume(tabId, { kind: "key", type: input.type, key: input.key })
  }

  consumeMouse(tabId: string, input: { type: string; button?: string }): boolean {
    return this.consume(tabId, { kind: "mouse", type: input.type, button: input.button })
  }

  clear(tabId: string): void { this.entries.delete(tabId) }

  private current(tabId: string): ExpectedInput[] {
    const now = this.now()
    return (this.entries.get(tabId) ?? []).filter((entry) => entry.expiresAt >= now)
  }

  private consume(tabId: string, actual: Omit<ExpectedInput, "expiresAt">): boolean {
    const current = this.current(tabId)
    const index = current.findIndex((entry) => entry.kind === actual.kind
      && entry.type === actual.type
      && (entry.key === undefined || entry.key.toLowerCase() === actual.key?.toLowerCase())
      && (entry.button === undefined || entry.button === actual.button))
    if (index < 0) {
      if (current.length) this.entries.set(tabId, current)
      else this.entries.delete(tabId)
      return false
    }
    current.splice(index, 1)
    if (current.length) this.entries.set(tabId, current)
    else this.entries.delete(tabId)
    return true
  }
}

function commandInputs(method: string, params: Record<string, unknown>, expiresAt: number): ExpectedInput[] {
  if (method === "Input.dispatchMouseEvent") {
    const type = ({ mouseMoved: "mouseMove", mousePressed: "mouseDown", mouseReleased: "mouseUp", mouseWheel: "mouseWheel" } as Record<string, string>)[String(params.type ?? "")]
    return type ? [{ kind: "mouse", type, ...(typeof params.button === "string" ? { button: params.button } : {}), expiresAt }] : []
  }
  if (method === "Input.dispatchKeyEvent") {
    const rawType = String(params.type ?? "")
    const type = rawType === "rawKeyDown" || rawType === "keyDown" ? "keyDown" : rawType === "keyUp" ? "keyUp" : rawType === "char" ? "char" : ""
    if (!type) return []
    const entry = { kind: "key" as const, type, key: String(params.key ?? ""), expiresAt }
    return rawType === "keyDown" && typeof params.text === "string" ? [entry, { kind: "key", type: "char", expiresAt }] : [entry]
  }
  if (method === "Input.insertText") return [{ kind: "key", type: "char", expiresAt }]
  return []
}
