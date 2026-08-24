export interface BrowserCdpCommandSender {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
}

export interface BrowserCdpPoint {
  x: number
  y: number
}

// 输入自然性：为注入事件补齐人类节奏（指针轨迹、按键驻留、逐字输入），
// 避免与用户共同操作同一页面时，混合事件流触发站点行为风控误伤。
// natural=true 启用；缺省为确定性直通注入，由 runtime 统一开关。
export type BrowserInputNaturalnessOptions = {
  natural?: boolean
  from?: BrowserCdpPoint
  speed?: "type" | "fill"
  sleep?: (milliseconds: number) => Promise<void>
  /** 拟真逐字输入的字符上限,超出部分一次性 insertText;默认 240(#638 打字时限) */
  maxNaturalChars?: number
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

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

const rand = (min: number, max: number) => min + Math.random() * (max - min)

// 从目标附近的随机偏移出发，避免每次动作都从同一个虚拟原点起手
function driftNear(point: BrowserCdpPoint): BrowserCdpPoint {
  return { x: Math.max(0, point.x + rand(-180, 180)), y: Math.max(0, point.y + rand(-140, 140)) }
}

// 三次贝塞尔轨迹：控制点沿法线方向随机弯曲，easeOut 采样使起步快、临近目标减速，
// 坐标叠加亚像素抖动（CDP dispatchMouseEvent 接受浮点坐标）
export function pointerPath(from: BrowserCdpPoint, to: BrowserCdpPoint): { points: BrowserCdpPoint[]; stepMs: number[] } {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  if (distance < 3) return { points: [], stepMs: [] }
  const steps = Math.max(6, Math.min(22, Math.round(distance / 45)))
  const normalX = -(to.y - from.y) / distance
  const normalY = (to.x - from.x) / distance
  const bow1 = rand(-0.16, 0.16) * distance
  const bow2 = rand(-0.16, 0.16) * distance
  const control1 = { x: from.x + (to.x - from.x) * 0.3 + normalX * bow1, y: from.y + (to.y - from.y) * 0.3 + normalY * bow1 }
  const control2 = { x: from.x + (to.x - from.x) * 0.72 + normalX * bow2, y: from.y + (to.y - from.y) * 0.72 + normalY * bow2 }
  const totalMs = Math.max(120, Math.min(520, distance * 2))
  const points: BrowserCdpPoint[] = []
  const stepMs: number[] = []
  for (let index = 1; index <= steps; index += 1) {
    const t = 1 - (1 - index / steps) ** 2
    const u = 1 - t
    points.push({
      x: u * u * u * from.x + 3 * u * u * t * control1.x + 3 * u * t * t * control2.x + t * t * t * to.x + rand(-0.35, 0.35),
      y: u * u * u * from.y + 3 * u * u * t * control1.y + 3 * u * t * t * control2.y + t * t * t * to.y + rand(-0.35, 0.35),
    })
    stepMs.push((totalMs / steps) * rand(0.75, 1.25))
  }
  return { points, stepMs }
}

async function walkPath(sender: BrowserCdpCommandSender, path: { points: BrowserCdpPoint[]; stepMs: number[] }, sleep: (milliseconds: number) => Promise<void>): Promise<void> {
  for (let index = 0; index < path.points.length; index += 1) {
    await sleep(path.stepMs[index])
    await sender.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: path.points[index].x, y: path.points[index].y })
  }
}

export async function dispatchBrowserClick(
  sender: BrowserCdpCommandSender,
  point: BrowserCdpPoint,
  clickCount = 1,
  options: BrowserInputNaturalnessOptions = {},
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep
  if (options.natural !== true) {
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
    return
  }
  await walkPath(sender, pointerPath(options.from ?? driftNear(point), point), sleep)
  for (let count = 1; count <= clickCount; count += 1) {
    if (count > 1) await sleep(rand(60, 140))
    await sender.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: count,
    })
    await sleep(rand(38, 95))
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

export async function moveBrowserPointer(
  sender: BrowserCdpCommandSender,
  point: BrowserCdpPoint,
  options: BrowserInputNaturalnessOptions = {},
): Promise<void> {
  if (options.natural !== true) {
    await sender.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y })
    return
  }
  await walkPath(sender, pointerPath(options.from ?? driftNear(point), point), options.sleep ?? defaultSleep)
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
  options: { platform: NodeJS.Platform; replace: boolean } & BrowserInputNaturalnessOptions,
): Promise<void> {
  if (options.replace) {
    await dispatchBrowserKey(sender, `${options.platform === "darwin" ? "Meta" : "Control"}+A`, options)
    await dispatchBrowserKey(sender, "Backspace", options)
  }
  if (!text) return
  if (options.natural !== true) {
    await sender.sendCommand("Input.insertText", { text })
    return
  }
  const sleep = options.sleep ?? defaultSleep
  const fast = options.speed === "fill"
  let minimum = fast ? 16 : 48
  let maximum = fast ? 52 : 145
  const characters = [...text]
  if (characters.length > 64) {
    minimum *= 0.6
    maximum *= 0.6
  }
  // 拟真逐字输入只保留前 maxNaturalChars 个字符:长文本全程逐字会以
  // ~60-90ms/字线性膨胀至分钟级,被 sidecar transport 超时误报(#638);
  // 剩余部分一次性 insertText 补完,拟真观感(防检测看行为模式)不受损。
  const maxNaturalChars = options.maxNaturalChars ?? 240
  const naturalCharacters = characters.slice(0, maxNaturalChars)
  let charactersUntilPause = 6 + Math.floor(rand(0, 9))
  for (const character of naturalCharacters) {
    const definition = keyDefinition(character, false)
    const typedText = definition.text
    await sender.sendCommand("Input.dispatchKeyEvent", {
      type: typedText ? "keyDown" : "rawKeyDown",
      key: definition.key,
      code: definition.code,
      ...(typedText ? { text: typedText, unmodifiedText: typedText } : {}),
      windowsVirtualKeyCode: definition.virtualKeyCode,
    })
    await sleep(rand(minimum, maximum))
    await sender.sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.virtualKeyCode,
    })
    charactersUntilPause -= 1
    if (charactersUntilPause <= 0) {
      // 打字过程中的短暂停顿（换行思考、扫视屏幕）
      await sleep(fast ? rand(90, 220) : rand(180, 420))
      charactersUntilPause = 6 + Math.floor(rand(0, 9))
    }
  }
  if (characters.length > naturalCharacters.length) {
    await sender.sendCommand("Input.insertText", { text: characters.slice(naturalCharacters.length).join("") })
  }
}

export async function dispatchBrowserKey(sender: BrowserCdpCommandSender, keySpec: string, options: BrowserInputNaturalnessOptions = {}): Promise<void> {
  const parsed = parseKeySpec(keySpec)
  const holdKey = options.natural === true ? () => (options.sleep ?? defaultSleep)(rand(45, 120)) : undefined
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
  await holdKey?.()
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
  // 逐字符注入多行文本时，换行符按回车合成（CDP 文本输入的标准换行形态）
  if (value === "\n") return { key: "Enter", code: "Enter", text: "\r", virtualKeyCode: 13 }
  if (/^[a-z]$/i.test(value)) {
    const upper = value.toUpperCase()
    const key = shifted ? upper : value.toLowerCase()
    return { key, code: `Key${upper}`, text: key, virtualKeyCode: upper.charCodeAt(0) }
  }
  if (/^[0-9]$/.test(value)) return { key: value, code: `Digit${value}`, text: value, virtualKeyCode: value.charCodeAt(0) }
  if ([...value].length === 1) return { key: value, code: "", text: value, virtualKeyCode: value.codePointAt(0) ?? 0 }
  return { key: value.slice(0, 64), code: value.slice(0, 64), virtualKeyCode: 0 }
}
