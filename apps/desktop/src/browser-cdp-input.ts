export interface BrowserCdpCommandSender {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
}

export interface BrowserCdpPoint {
  x: number
  y: number
}

type KeyDefinition = {
  code: string
  key: string
  text?: string
  virtualKeyCode: number
}

const MODIFIERS = {
  Alt: { bit: 1, code: "AltLeft", virtualKeyCode: 18 },
  Control: { bit: 2, code: "ControlLeft", virtualKeyCode: 17 },
  Meta: { bit: 4, code: "MetaLeft", virtualKeyCode: 91 },
  Shift: { bit: 8, code: "ShiftLeft", virtualKeyCode: 16 },
} as const

type ModifierName = keyof typeof MODIFIERS

export async function dispatchBrowserClick(
  sender: BrowserCdpCommandSender,
  point: BrowserCdpPoint,
  clickCount = 1,
): Promise<void> {
  await sender.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y })
  for (let count = 1; count <= clickCount; count += 1) {
    await sender.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: count,
    })
    await sender.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: count,
    })
  }
}

export async function focusBrowserPoint(sender: BrowserCdpCommandSender, point: BrowserCdpPoint): Promise<void> {
  await sender.sendCommand("DOM.enable")
  const located = await sender.sendCommand("DOM.getNodeForLocation", {
    x: Math.round(point.x),
    y: Math.round(point.y),
    // UA shadow descendants cannot become document.activeElement; focus and
    // verify the owning form control instead of its internal presentation node.
    includeUserAgentShadowDOM: false,
  }) as { backendNodeId?: unknown }
  if (!Number.isInteger(located.backendNodeId)) throw Object.assign(new Error("stale_target"), { code: "stale_target" })
  await sender.sendCommand("DOM.focus", { backendNodeId: located.backendNodeId }).catch(() => undefined)
  // DOM.focus may succeed without changing focus for labels and nested presentation nodes.
  // Resolve the exact hit node to verify focus and redirect associated labels to their control.
  const resolved = await sender.sendCommand("DOM.resolveNode", { backendNodeId: located.backendNodeId }) as { object?: { objectId?: unknown } }
  const objectId = typeof resolved.object?.objectId === "string" ? resolved.object.objectId : ""
  if (!objectId) throw Object.assign(new Error("stale_target"), { code: "stale_target" })
  try {
    const focused = await sender.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        const element = this.nodeType === 1 ? this : this.parentElement;
        if (!element) return false;
        const label = element.closest?.("label");
        const target = label?.control || element.closest?.("input,textarea,select,button,a[href],[tabindex],[contenteditable=true]") || element;
        if (typeof target.focus !== "function") return false;
        target.focus({ preventScroll: true });
        const active = target.ownerDocument?.activeElement;
        return active === target || Boolean(active && target.contains?.(active));
      }`,
      returnByValue: true,
    }) as { result?: { value?: unknown } }
    if (focused.result?.value !== true) throw Object.assign(new Error("stale_target"), { code: "stale_target" })
  } finally {
    await sender.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined)
  }
}

export async function dispatchBrowserText(
  sender: BrowserCdpCommandSender,
  text: string,
  options: { platform: NodeJS.Platform; replace: boolean },
): Promise<void> {
  if (options.replace) {
    await dispatchBrowserKey(sender, `${options.platform === "darwin" ? "Meta" : "Control"}+A`)
    await dispatchBrowserKey(sender, "Backspace")
  }
  if (text) await sender.sendCommand("Input.insertText", { text })
}

export async function dispatchBrowserKey(sender: BrowserCdpCommandSender, keySpec: string): Promise<void> {
  const parsed = parseKeySpec(keySpec)
  let activeModifiers = 0
  for (const modifier of parsed.modifiers) {
    const definition = MODIFIERS[modifier]
    activeModifiers |= definition.bit
    await sender.sendCommand("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: modifier,
      code: definition.code,
      modifiers: activeModifiers,
      windowsVirtualKeyCode: definition.virtualKeyCode,
    })
  }

  const text = parsed.key.text && (activeModifiers & 7) === 0 ? parsed.key.text : undefined
  await sender.sendCommand("Input.dispatchKeyEvent", {
    type: text ? "keyDown" : "rawKeyDown",
    key: parsed.key.key,
    code: parsed.key.code,
    ...(text ? { text, unmodifiedText: text } : {}),
    modifiers: activeModifiers,
    windowsVirtualKeyCode: parsed.key.virtualKeyCode,
  })
  await sender.sendCommand("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: parsed.key.key,
    code: parsed.key.code,
    modifiers: activeModifiers,
    windowsVirtualKeyCode: parsed.key.virtualKeyCode,
  })

  for (const modifier of [...parsed.modifiers].reverse()) {
    const definition = MODIFIERS[modifier]
    activeModifiers &= ~definition.bit
    await sender.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: modifier,
      code: definition.code,
      modifiers: activeModifiers,
      windowsVirtualKeyCode: definition.virtualKeyCode,
    })
  }
}

function parseKeySpec(keySpec: string): { key: KeyDefinition; modifiers: ModifierName[] } {
  const parts = keySpec.split("+").map((part) => part.trim()).filter(Boolean)
  const rawKey = parts.pop() || "Enter"
  const modifiers = Array.from(new Set(parts.map(normalizeModifier).filter((value): value is ModifierName => Boolean(value))))
  return { key: keyDefinition(rawKey, modifiers.includes("Shift")), modifiers }
}

function normalizeModifier(value: string): ModifierName | undefined {
  if (value === "Ctrl" || value === "Control") return "Control"
  if (value === "Cmd" || value === "Command" || value === "Meta") return "Meta"
  if (value === "Alt" || value === "Option") return "Alt"
  if (value === "Shift") return "Shift"
  return undefined
}

function keyDefinition(value: string, shifted: boolean): KeyDefinition {
  const aliases: Record<string, KeyDefinition> = {
    Backspace: { key: "Backspace", code: "Backspace", virtualKeyCode: 8 },
    Delete: { key: "Delete", code: "Delete", virtualKeyCode: 46 },
    Enter: { key: "Enter", code: "Enter", text: "\r", virtualKeyCode: 13 },
    Escape: { key: "Escape", code: "Escape", virtualKeyCode: 27 },
    Space: { key: " ", code: "Space", text: " ", virtualKeyCode: 32 },
    Tab: { key: "Tab", code: "Tab", virtualKeyCode: 9 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38 },
  }
  if (aliases[value]) return aliases[value]!
  if (/^[a-z]$/i.test(value)) {
    const upper = value.toUpperCase()
    const key = shifted ? upper : value.toLowerCase()
    return { key, code: `Key${upper}`, text: key, virtualKeyCode: upper.charCodeAt(0) }
  }
  if (/^[0-9]$/.test(value)) return { key: value, code: `Digit${value}`, text: value, virtualKeyCode: value.charCodeAt(0) }
  if ([...value].length === 1) return { key: value, code: "", text: value, virtualKeyCode: value.codePointAt(0) ?? 0 }
  return { key: value.slice(0, 64), code: value.slice(0, 64), virtualKeyCode: 0 }
}
