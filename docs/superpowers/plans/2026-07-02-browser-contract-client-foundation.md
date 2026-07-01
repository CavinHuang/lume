# Browser Contract And Client Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the Codex-compatible browser API catalog, backend negotiation, dynamic API projection, dynamic documentation, and fake-backend conformance foundation without advertising unfinished browser capabilities.

**Architecture:** The `lume-chrome` plugin remains the owner of the public BrowserClient. A checked-in contract catalog describes public interface members and backend defaults; a runtime projection hides unavailable members; backend descriptors drive selection and typed capabilities. Existing Chrome transport remains in place during this phase, while a deterministic fake backend proves the client contract before BrowserBroker and IAB are introduced.

**Tech Stack:** TypeScript ES2022, Node.js built-in test runner, JSON-RPC, existing Lume plugin build scripts, no new dependencies.

---

## Program Boundary

This is plan 1 of the unified browser program. It deliberately does not implement Electron
`WebContentsView`, BrowserBroker, Chrome transport migration, secure browser auth, or real-browser
E2E. Those are separate plans because each changes an independent subsystem and must remain
individually reviewable.

The remaining plans execute in this order:

1. BrowserBroker and opaque Node REPL transport.
2. Electron IAB `WebContentsView` backend and iframe removal.
3. Chrome backend transport migration and public object-model parity.
4. Unified confirmation, secure browserAuth, and response metadata.
5. Shared real-browser E2E, Windows PR gate, and legacy cleanup.

Execute this plan in the `lume-plugins` repository rooted at:

`D:\workspace\projects\ai-projects\lume-plugins`

The approved design is:

`D:\workspace\projects\ai-projects\lume\docs\superpowers\specs\2026-07-02-unified-browser-runtime-design.md`

Before execution, preserve the existing dirty changes in `plugins/lume-chrome` in a dedicated
commit or worktree. Do not discard or overwrite them. Every commit below must follow the Lore
protocol used by the Lume repositories.

## File Map

### New files

- `plugins/lume-chrome/src/client/api-contract.ts`: canonical public interface member catalog and backend default support rules.
- `plugins/lume-chrome/src/client/runtime-view.ts`: Proxy-based removal of unavailable API members.
- `plugins/lume-chrome/src/client/backend-selection.ts`: deterministic `getDefault()` and `getForUrl()` selection policy.
- `plugins/lume-chrome/src/client/documentation.ts`: effective API and conditional guidance composition.
- `plugins/lume-chrome/src/client/capabilities.ts`: typed capability definitions and factories.
- `plugins/lume-chrome/tests/helpers/fake-browser-backend.mjs`: deterministic transport used by client conformance tests.
- `plugins/lume-chrome/tests/api-contract.test.mjs`: exact public catalog and backend-default tests.
- `plugins/lume-chrome/tests/runtime-view.test.mjs`: hidden-member reflection tests.
- `plugins/lume-chrome/tests/backend-selection.test.mjs`: browser selection tests.
- `plugins/lume-chrome/tests/documentation.test.mjs`: effective documentation tests.
- `plugins/lume-chrome/tests/capabilities.test.mjs`: typed capability tests.
- `plugins/lume-chrome/tests/client-conformance.test.mjs`: end-to-end client tests against the fake backend.

### Modified files

- `plugins/lume-chrome/src/shared/protocol.ts`: add backend descriptor, generation, capability, and API override wire types.
- `plugins/lume-chrome/src/client/BrowserClient.ts`: consume backend descriptors, runtime projection, typed capabilities, and selection policy.
- `plugins/lume-chrome/src/client/setupBrowserRuntime.ts`: expose `agent.browsers` and `agent.documentation` once per kernel.
- `plugins/lume-chrome/src/client/setupNodeReplBrowserRuntime.ts`: adapt the temporary Chrome bridge to the new descriptor contract without adding new facade behavior.
- `plugins/lume-chrome/src/extension/runtime/RuntimeDispatcher.ts`: return a complete extension backend descriptor from discovery and ping.
- `plugins/lume-chrome/src/extension/runtime/NativeTransport.ts`: expose a monotonic connection generation.
- `plugins/lume-chrome/package.json`: add focused contract and conformance test scripts.

## Task 1: Add The Canonical Public API Catalog

**Files:**
- Create: `plugins/lume-chrome/src/client/api-contract.ts`
- Create: `plugins/lume-chrome/tests/api-contract.test.mjs`

- [ ] **Step 1: Write the failing catalog test**

Create `plugins/lume-chrome/tests/api-contract.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  API_MEMBERS,
  DEFAULT_UNSUPPORTED_MEMBERS,
  PUBLIC_INTERFACE_NAMES,
  disabledMembersFor,
} from "../dist/client/api-contract.js";

const expected = {
  Agent: ["browsers", "documentation"],
  Browsers: ["get", "getDefault", "getForUrl", "list"],
  Browser: ["browserId", "capabilities", "tabs", "user", "documentation", "nameSession"],
  BrowserUser: ["claimTab", "history", "openTabs"],
  Tabs: ["content", "finalize", "get", "list", "new", "selected"],
  Tab: [
    "capabilities", "clipboard", "content", "cua", "dev", "dom_cua", "id", "playwright",
    "back", "close", "forward", "getJsDialog", "goto", "markDeliverable", "markHandoff",
    "reload", "screenshot", "title", "url",
  ],
  ContentAPI: ["export", "exportGsuite"],
  CUAAPI: ["click", "double_click", "downloadMedia", "drag", "keypress", "move", "scroll", "type"],
  DomCUAAPI: ["click", "double_click", "downloadMedia", "get_visible_dom", "keypress", "scroll", "type"],
  PlaywrightAPI: [
    "domSnapshot", "elementInfo", "elementScreenshot", "evaluate", "expectNavigation", "frameLocator",
    "getByLabel", "getByPlaceholder", "getByRole", "getByTestId", "getByText", "locator",
    "waitForEvent", "waitForLoadState", "waitForTimeout", "waitForURL",
  ],
  PlaywrightFrameLocator: [
    "frameLocator", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId", "getByText", "locator",
  ],
  PlaywrightLocator: [
    "all", "allTextContents", "and", "check", "click", "count", "dblclick", "downloadMedia", "fill",
    "filter", "first", "getAttribute", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId",
    "getByText", "innerText", "isEnabled", "isVisible", "last", "locator", "nth", "or", "press",
    "selectOption", "setChecked", "textContent", "type", "uncheck", "waitFor",
  ],
  PlaywrightDownload: ["path"],
  PlaywrightFileChooser: ["isMultiple", "setFiles"],
  TabClipboardAPI: ["read", "readText", "write", "writeText"],
  TabDevAPI: ["logs"],
  AlertDialog: ["type", "dismiss"],
  BeforeUnloadDialog: ["type", "dismiss"],
  ConfirmDialog: ["type", "accept", "dismiss"],
  PromptDialog: ["type", "accept", "dismiss"],
  BrowserDocumentation: ["api", "get", "guidance", "lookupCatalog"],
  Documentation: ["get"],
};

test("public API catalog matches the approved compatibility baseline", () => {
  assert.deepEqual(PUBLIC_INTERFACE_NAMES, Object.keys(expected));
  for (const [name, members] of Object.entries(expected)) {
    assert.deepEqual(API_MEMBERS[name], members, name);
  }
  assert.equal(JSON.stringify(API_MEMBERS).includes("webmcp"), false);
  assert.equal(JSON.stringify(API_MEMBERS).includes("lumeBrowser"), false);
});

test("backend defaults hide unsupported members", () => {
  assert.deepEqual(DEFAULT_UNSUPPORTED_MEMBERS.extension, ["Tabs.content"]);
  assert.deepEqual(DEFAULT_UNSUPPORTED_MEMBERS.iab, [
    "BrowserUser.claimTab", "BrowserUser.history", "Tabs.content", "Tabs.finalize",
    "Tab.markDeliverable", "Tab.markHandoff", "CUAAPI.downloadMedia",
    "DomCUAAPI.downloadMedia", "PlaywrightFileChooser.setFiles",
  ]);
  assert.equal(disabledMembersFor("extension", { "Tabs.content": true }).has("Tabs.content"), false);
  assert.equal(disabledMembersFor("extension", { "Tab.getJsDialog": false }).has("Tab.getJsDialog"), true);
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run:

```powershell
cd D:\workspace\projects\ai-projects\lume-plugins\plugins\lume-chrome
npm run build
node --test tests/api-contract.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `dist/client/api-contract.js`.

- [ ] **Step 3: Implement the catalog and backend rules**

Create `plugins/lume-chrome/src/client/api-contract.ts` with these exported shapes:

```ts
export type BrowserBackendType = "iab" | "extension" | "cdp";
export type ApiSupportOverrides = Record<string, boolean>;

export const API_MEMBERS = {
  Agent: ["browsers", "documentation"],
  Browsers: ["get", "getDefault", "getForUrl", "list"],
  Browser: ["browserId", "capabilities", "tabs", "user", "documentation", "nameSession"],
  BrowserUser: ["claimTab", "history", "openTabs"],
  Tabs: ["content", "finalize", "get", "list", "new", "selected"],
  Tab: [
    "capabilities", "clipboard", "content", "cua", "dev", "dom_cua", "id", "playwright",
    "back", "close", "forward", "getJsDialog", "goto", "markDeliverable", "markHandoff",
    "reload", "screenshot", "title", "url",
  ],
  ContentAPI: ["export", "exportGsuite"],
  CUAAPI: ["click", "double_click", "downloadMedia", "drag", "keypress", "move", "scroll", "type"],
  DomCUAAPI: ["click", "double_click", "downloadMedia", "get_visible_dom", "keypress", "scroll", "type"],
  PlaywrightAPI: [
    "domSnapshot", "elementInfo", "elementScreenshot", "evaluate", "expectNavigation", "frameLocator",
    "getByLabel", "getByPlaceholder", "getByRole", "getByTestId", "getByText", "locator",
    "waitForEvent", "waitForLoadState", "waitForTimeout", "waitForURL",
  ],
  PlaywrightFrameLocator: [
    "frameLocator", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId", "getByText", "locator",
  ],
  PlaywrightLocator: [
    "all", "allTextContents", "and", "check", "click", "count", "dblclick", "downloadMedia", "fill",
    "filter", "first", "getAttribute", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId",
    "getByText", "innerText", "isEnabled", "isVisible", "last", "locator", "nth", "or", "press",
    "selectOption", "setChecked", "textContent", "type", "uncheck", "waitFor",
  ],
  PlaywrightDownload: ["path"],
  PlaywrightFileChooser: ["isMultiple", "setFiles"],
  TabClipboardAPI: ["read", "readText", "write", "writeText"],
  TabDevAPI: ["logs"],
  AlertDialog: ["type", "dismiss"],
  BeforeUnloadDialog: ["type", "dismiss"],
  ConfirmDialog: ["type", "accept", "dismiss"],
  PromptDialog: ["type", "accept", "dismiss"],
  BrowserDocumentation: ["api", "get", "guidance", "lookupCatalog"],
  Documentation: ["get"],
} as const;

export const PUBLIC_INTERFACE_NAMES = Object.keys(API_MEMBERS) as Array<keyof typeof API_MEMBERS>;

export const DEFAULT_UNSUPPORTED_MEMBERS: Record<BrowserBackendType, string[]> = {
  extension: ["Tabs.content"],
  iab: [
    "BrowserUser.claimTab", "BrowserUser.history", "Tabs.content", "Tabs.finalize",
    "Tab.markDeliverable", "Tab.markHandoff", "CUAAPI.downloadMedia",
    "DomCUAAPI.downloadMedia", "PlaywrightFileChooser.setFiles",
  ],
  cdp: [
    "BrowserUser.claimTab", "BrowserUser.history", "Tabs.content", "Tabs.finalize",
    "Tab.markDeliverable", "Tab.markHandoff",
  ],
};

export function disabledMembersFor(
  type: BrowserBackendType,
  overrides: ApiSupportOverrides = {},
): Set<string> {
  const disabled = new Set(DEFAULT_UNSUPPORTED_MEMBERS[type]);
  for (const [member, supported] of Object.entries(overrides)) {
    if (supported) disabled.delete(member);
    else disabled.add(member);
  }
  return disabled;
}
```

- [ ] **Step 4: Build and run the focused test**

Run:

```powershell
npm run build
node --test tests/api-contract.test.mjs
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit the catalog**

```powershell
git add src/client/api-contract.ts tests/api-contract.test.mjs
git commit -m "🏗️ arch(browser): 建立浏览器公开契约目录" -m "以已审查的 Codex 公开接口为兼容基线，不包含 internal WebMCP 和 Lume facade。`n`nConstraint: 未完成成员必须由 backend override 隐藏`nTested: npm run build; node --test tests/api-contract.test.mjs"
```

## Task 2: Define Backend Descriptors And A Fake Transport

**Files:**
- Modify: `plugins/lume-chrome/src/shared/protocol.ts`
- Create: `plugins/lume-chrome/tests/helpers/fake-browser-backend.mjs`
- Create: `plugins/lume-chrome/tests/backend-descriptor.test.mjs`

- [ ] **Step 1: Write the failing descriptor test**

Create `plugins/lume-chrome/tests/backend-descriptor.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBackend } from "./helpers/fake-browser-backend.mjs";

test("fake backend returns a versioned backend descriptor", async () => {
  const fake = createFakeBackend({
    id: "iab-local",
    type: "iab",
    generation: 3,
    browserCapabilities: [{ id: "viewport", description: "Viewport control" }],
  });
  const listed = await fake.transport.send("runtime_list_browsers", {});
  assert.deepEqual(listed, [{
    id: "iab-local",
    name: "Lume Local Browser",
    type: "iab",
    protocolVersion: 5,
    generation: 3,
    metadata: {},
    capabilities: {
      browser: [{ id: "viewport", description: "Viewport control" }],
      tab: [],
    },
    apiSupportOverrides: {},
  }]);
});

test("fake backend records commands and returns configured results", async () => {
  const fake = createFakeBackend({ id: "chrome-1", type: "extension" });
  fake.respond("browser_user_open_tabs", [{ id: "42", url: "https://example.com/" }]);
  assert.deepEqual(await fake.transport.send("browser_user_open_tabs", {}), [
    { id: "42", url: "https://example.com/" },
  ]);
  assert.equal(fake.calls.at(-1).method, "browser_user_open_tabs");
});
```

- [ ] **Step 2: Run the test and verify the helper is missing**

Run: `node --test tests/backend-descriptor.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `tests/helpers/fake-browser-backend.mjs`.

- [ ] **Step 3: Add protocol types**

In `plugins/lume-chrome/src/shared/protocol.ts`, replace the old discovery-only
`BrowserCapabilities` shape with these additive types while retaining the old alias until Task 7:

```ts
export interface AdvertisedCapability {
  id: string;
  description: string;
}

export interface BrowserBackendDescriptor {
  id: string;
  name: string;
  type: BrowserClientType;
  protocolVersion: number;
  generation: number;
  metadata: Record<string, string>;
  capabilities: {
    browser: AdvertisedCapability[];
    tab: AdvertisedCapability[];
  };
  apiSupportOverrides: Record<string, boolean>;
}

export interface BrowserCapabilities extends BrowserBackendDescriptor {
  browserId: string;
  clientType: BrowserClientType;
  permissions: Record<string, PermissionState>;
  features: Record<string, FeatureState>;
}
```

Set `PROTOCOL_VERSION` to `5`. Do not change Native Host or App Server protocol versions in this
task; their migration belongs to the Broker plan.

- [ ] **Step 4: Implement the fake backend helper**

Create `plugins/lume-chrome/tests/helpers/fake-browser-backend.mjs`:

```js
export function createFakeBackend(options) {
  const descriptor = {
    id: options.id,
    name: options.name ?? (options.type === "iab" ? "Lume Local Browser" : "Lume Chrome"),
    type: options.type,
    protocolVersion: 5,
    generation: options.generation ?? 1,
    metadata: options.metadata ?? {},
    capabilities: {
      browser: options.browserCapabilities ?? [],
      tab: options.tabCapabilities ?? [],
    },
    apiSupportOverrides: options.apiSupportOverrides ?? {},
  };
  const calls = [];
  const responses = new Map();
  responses.set("runtime_list_browsers", [descriptor]);
  responses.set("runtime_ping", descriptor);

  return {
    calls,
    descriptor,
    respond(method, result) {
      responses.set(method, result);
    },
    transport: {
      async send(method, params) {
        calls.push({ method, params });
        if (!responses.has(method)) throw new Error(`No fake response for ${method}`);
        const value = responses.get(method);
        return typeof value === "function" ? value(params) : structuredClone(value);
      },
    },
  };
}
```

- [ ] **Step 5: Run the descriptor tests**

Run:

```powershell
npm run build
node --test tests/backend-descriptor.test.mjs
```

Expected: 2 tests PASS.

- [ ] **Step 6: Commit the descriptor contract**

```powershell
git add src/shared/protocol.ts tests/helpers/fake-browser-backend.mjs tests/backend-descriptor.test.mjs
git commit -m "🏗️ arch(browser): 定义版本化后端描述协议" -m "为动态能力和 backend generation 提供稳定 wire contract，并加入无依赖 fake transport。`n`nConstraint: 暂不迁移 Native Host transport`nTested: npm run build; node --test tests/backend-descriptor.test.mjs"
```

## Task 3: Hide Unsupported Runtime Members

**Files:**
- Create: `plugins/lume-chrome/src/client/runtime-view.ts`
- Create: `plugins/lume-chrome/tests/runtime-view.test.mjs`

- [ ] **Step 1: Write reflection-complete failing tests**

Create `plugins/lume-chrome/tests/runtime-view.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeView } from "../dist/client/runtime-view.js";

class Tabs {
  list() { return ["tab-1"]; }
  content() { return "hidden"; }
}

class Browser {
  constructor() { this.tabs = new Tabs(); }
  documentation() { return "docs"; }
}

test("runtime view hides disabled members through every reflection path", () => {
  const project = createRuntimeView(new Set(["Tabs.content"]));
  const browser = project(new Browser());
  assert.deepEqual(browser.tabs.list(), ["tab-1"]);
  assert.equal(browser.tabs.content, undefined);
  assert.equal("content" in browser.tabs, false);
  assert.equal(Reflect.ownKeys(browser.tabs).includes("content"), false);
  assert.equal(Object.getOwnPropertyDescriptor(browser.tabs, "content"), undefined);
});

test("runtime view preserves object identity and unwraps proxy arguments", () => {
  class PlaywrightLocator {
    and(other) { return other; }
  }
  const project = createRuntimeView(new Set());
  const locator = project(new PlaywrightLocator());
  assert.equal(project(locator), locator);
  assert.equal(locator.and(locator), locator);
});

test("runtime view projects promised and array results", async () => {
  class BrowserUser {
    async openTabs() { return [new Tabs()]; }
  }
  const project = createRuntimeView(new Set(["Tabs.content"]));
  const user = project(new BrowserUser());
  const [tabs] = await user.openTabs();
  assert.equal(tabs.content, undefined);
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `npm run build; node --test tests/runtime-view.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `runtime-view.js`.

- [ ] **Step 3: Implement the projection**

Create `plugins/lume-chrome/src/client/runtime-view.ts`:

```ts
import { API_MEMBERS } from "./api-contract";

type Constructor = new (...args: never[]) => object;

export function createRuntimeView(disabled: Set<string>) {
  const proxies = new WeakMap<object, object>();
  const targets = new WeakMap<object, object>();
  const methodCache = new WeakMap<object, Map<PropertyKey, Function>>();

  const interfaceName = (value: object): string | null => {
    const ctor = value.constructor as Constructor | undefined;
    return typeof ctor?.name === "string" && ctor.name ? ctor.name : null;
  };

  const unwrap = <T>(value: T): T => {
    if (value && (typeof value === "object" || typeof value === "function")) {
      return (targets.get(value as object) ?? value) as T;
    }
    return value;
  };

  const project = <T>(value: T): T => {
    if ((value as any) instanceof Promise) return (value as Promise<unknown>).then(project) as T;
    if (Array.isArray(value)) return value.map(project) as T;
    if (!value || typeof value !== "object") return value;
    if (targets.has(value as object)) return value;
    const cached = proxies.get(value as object);
    if (cached) return cached as T;

    const name = interfaceName(value as object);
    if (!name || !(name in API_MEMBERS)) return value;
    const allowed = (property: PropertyKey) =>
      typeof property !== "string" || !disabled.has(`${name}.${property}`);

    const proxy = new Proxy(value as object, {
      get(target, property, receiver) {
        if (!allowed(property)) return undefined;
        const member = Reflect.get(target, property, receiver);
        if (property === "constructor" || typeof member !== "function") return project(member);
        const cache = methodCache.get(target) ?? new Map<PropertyKey, Function>();
        methodCache.set(target, cache);
        const existing = cache.get(property);
        if (existing) return existing;
        const wrapped = (...args: unknown[]) => project(Reflect.apply(member, target, args.map(unwrap)));
        cache.set(property, wrapped);
        return wrapped;
      },
      getOwnPropertyDescriptor(target, property) {
        return allowed(property) ? Reflect.getOwnPropertyDescriptor(target, property) : undefined;
      },
      has(target, property) {
        return allowed(property) && Reflect.has(target, property);
      },
      ownKeys(target) {
        return Reflect.ownKeys(target).filter(allowed);
      },
    });
    proxies.set(value as object, proxy);
    targets.set(proxy, value as object);
    return proxy as T;
  };

  return project;
}
```

Restricting projection to cataloged interface constructors prevents ordinary response objects from
being wrapped.

- [ ] **Step 4: Run the projection tests**

Run: `npm run build; node --test tests/runtime-view.test.mjs`

Expected: 3 tests PASS.

- [ ] **Step 5: Commit the runtime projection**

```powershell
git add src/client/runtime-view.ts tests/runtime-view.test.mjs
git commit -m "✨ feat(browser): 按后端裁剪运行时 API" -m "使用稳定 Proxy 视图隐藏未支持成员，并保持对象身份、Promise 与参数解包语义。`n`nTested: npm run build; node --test tests/runtime-view.test.mjs"
```

## Task 4: Implement Deterministic Backend Selection

**Files:**
- Create: `plugins/lume-chrome/src/client/backend-selection.ts`
- Create: `plugins/lume-chrome/tests/backend-selection.test.mjs`

- [ ] **Step 1: Write the selection tests**

Create `plugins/lume-chrome/tests/backend-selection.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { chooseDefaultBackend, chooseBackendForUrl, isLocalBrowserUrl } from "../dist/client/backend-selection.js";

const iab = { id: "iab-1", type: "iab", openTabUrls: [] };
const chrome = { id: "chrome-1", type: "extension", openTabUrls: [] };

test("local URL classification rejects public and private-LAN targets", () => {
  for (const url of [
    "http://localhost:3000/", "https://localhost/", "http://127.0.0.9:8080/", "http://[::1]/",
  ]) assert.equal(isLocalBrowserUrl(url), true, url);
  for (const url of [
    "https://example.com/", "http://192.168.1.10/", "http://10.0.0.1/", "http://172.16.0.1/",
  ]) assert.equal(isLocalBrowserUrl(url), false, url);
});

test("default selection prefers IAB and falls back to Chrome", () => {
  assert.equal(chooseDefaultBackend([chrome, iab]).id, "iab-1");
  assert.equal(chooseDefaultBackend([chrome]).id, "chrome-1");
});

test("URL selection routes local targets to IAB and public targets to Chrome", () => {
  assert.equal(chooseBackendForUrl([chrome, iab], "http://localhost:3000/").id, "iab-1");
  assert.equal(chooseBackendForUrl([chrome, iab], "https://example.com/").id, "chrome-1");
});

test("an existing matching Chrome tab wins for public URLs", () => {
  const withTab = { ...chrome, openTabUrls: ["https://example.com/account#profile"] };
  assert.equal(chooseBackendForUrl([iab, withTab], "https://example.com/account").id, "chrome-1");
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `npm run build; node --test tests/backend-selection.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `backend-selection.js`.

- [ ] **Step 3: Implement the selection policy**

Create `plugins/lume-chrome/src/client/backend-selection.ts`:

```ts
import type { BrowserBackendDescriptor } from "../shared/protocol";

export interface SelectableBackend extends BrowserBackendDescriptor {
  openTabUrls: string[];
}

export function isLocalBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || host === "[::1]") return true;
    const octets = host.split(".").map(Number);
    return octets.length === 4
      && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
      && octets[0] === 127;
  } catch {
    return false;
  }
}

export function chooseDefaultBackend(backends: SelectableBackend[]): SelectableBackend {
  const selected = backends.find((backend) => backend.type === "iab")
    ?? backends.find((backend) => backend.type === "extension")
    ?? backends[0];
  if (!selected) throw new Error("No browser is available");
  return selected;
}

function comparableUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function chooseBackendForUrl(backends: SelectableBackend[], value: string): SelectableBackend {
  const target = comparableUrl(value);
  if (!target) throw new Error(`Invalid browser URL: ${value}`);
  const preferredType = isLocalBrowserUrl(target.href) ? "iab" : "extension";
  const candidates = backends.filter((backend) => backend.type === preferredType);
  const matching = candidates.find((backend) => backend.openTabUrls.some((candidate) => {
    const open = comparableUrl(candidate);
    return open?.href === target.href
      || (open?.origin === target.origin && open.pathname === target.pathname)
      || open?.hostname === target.hostname;
  }));
  const selected = matching ?? candidates[0];
  if (!selected) throw new Error(`No ${preferredType} browser is available for ${target.href}`);
  return selected;
}
```

- [ ] **Step 4: Run the focused tests**

Run: `npm run build; node --test tests/backend-selection.test.mjs`

Expected: 4 tests PASS.

- [ ] **Step 5: Commit the selection policy**

```powershell
git add src/client/backend-selection.ts tests/backend-selection.test.mjs
git commit -m "✨ feat(browser): 统一本地与 Chrome 后端选择" -m "本地 loopback 目标选择 IAB，公网目标选择 Chrome，并优先复用匹配标签页。`n`nConstraint: 私有局域网不属于 IAB 本地范围`nTested: npm run build; node --test tests/backend-selection.test.mjs"
```

## Task 5: Add Typed Capability Objects

**Files:**
- Create: `plugins/lume-chrome/src/client/capabilities.ts`
- Create: `plugins/lume-chrome/tests/capabilities.test.mjs`
- Modify: `plugins/lume-chrome/src/client/BrowserClient.ts`

- [ ] **Step 1: Write tests for callable capabilities**

Create `plugins/lume-chrome/tests/capabilities.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityCollection, createCapabilityDefinitions } from "../dist/client/capabilities.js";

function makeTransport() {
  const calls = [];
  return {
    calls,
    async send(method, params) {
      calls.push({ method, params });
      if (method.endsWith("_documentation")) return `docs:${params.capabilityId}`;
      if (method === "browser_visibility_get") return true;
      if (method === "tab_page_assets_list") return { id: "inventory-1", assets: [] };
      return null;
    },
  };
}

test("capabilities.get returns the callable capability object", async () => {
  const transport = makeTransport();
  const definitions = createCapabilityDefinitions();
  const collection = new CapabilityCollection({
    advertised: [{ id: "visibility", description: "Show or hide browser" }],
    browserId: "iab-1",
    definitions,
    scope: "browser",
    transport,
  });
  assert.deepEqual(await collection.list(), [{ id: "visibility", description: "Show or hide browser" }]);
  const visibility = await collection.get("visibility");
  assert.equal(await visibility.get(), true);
  assert.equal(await visibility.documentation(), "docs:visibility");
});

test("tab capability carries browser and tab identity", async () => {
  const transport = makeTransport();
  const collection = new CapabilityCollection({
    advertised: [{ id: "pageAssets", description: "Page assets" }],
    browserId: "chrome-1",
    definitions: createCapabilityDefinitions(),
    scope: "tab",
    tabId: "42",
    transport,
  });
  const assets = await collection.get("pageAssets");
  assert.deepEqual(await assets.list(), { id: "inventory-1", assets: [] });
  assert.deepEqual(transport.calls.at(-1).params, { browserId: "chrome-1", tabId: "42" });
});

test("unknown and internal capabilities are unavailable", async () => {
  const collection = new CapabilityCollection({
    advertised: [{ id: "webmcp", description: "internal" }],
    browserId: "chrome-1",
    definitions: createCapabilityDefinitions(),
    scope: "tab",
    tabId: "42",
    transport: makeTransport(),
  });
  await assert.rejects(collection.get("webmcp"), /Capability not available: webmcp/);
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `npm run build; node --test tests/capabilities.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `capabilities.js`.

- [ ] **Step 3: Implement the capability factory boundary**

Create `plugins/lume-chrome/src/client/capabilities.ts`. Define these public classes and command
mappings:

```ts
import type { AdvertisedCapability, BrowserCommandType } from "../shared/protocol";
import type { BrowserTransport } from "./BrowserClient";

interface CapabilityContext {
  browserId: string;
  tabId?: string;
  transport: BrowserTransport;
}

interface CapabilityDefinition {
  id: string;
  scope: "browser" | "tab";
  create(context: CapabilityContext): object;
}

class DocumentedCapability {
  constructor(
    protected readonly context: CapabilityContext,
    private readonly id: string,
    private readonly scope: "browser" | "tab",
  ) {}
  documentation(): Promise<string> {
    const method: BrowserCommandType = this.scope === "browser"
      ? "browser_capability_documentation"
      : "tab_capability_documentation";
    return this.context.transport.send(method, {
      browserId: this.context.browserId,
      ...(this.context.tabId ? { tabId: this.context.tabId } : {}),
      capabilityId: this.id,
    });
  }
}

class VisibilityCapability extends DocumentedCapability {
  get(): Promise<boolean> {
    return this.context.transport.send("browser_visibility_get", { browserId: this.context.browserId });
  }
  set(visible: boolean): Promise<void> {
    return this.context.transport.send("browser_visibility_set", { browserId: this.context.browserId, visible });
  }
}

class ViewportCapability extends DocumentedCapability {
  set(options: { width: number; height: number }): Promise<void> {
    return this.context.transport.send("browser_viewport_set", { browserId: this.context.browserId, options });
  }
  reset(): Promise<void> {
    return this.context.transport.send("browser_viewport_reset", { browserId: this.context.browserId });
  }
}

class PageAssetsCapability extends DocumentedCapability {
  list(): Promise<unknown> {
    return this.context.transport.send("tab_page_assets_list", {
      browserId: this.context.browserId,
      tabId: this.context.tabId,
    });
  }
  bundle(options: unknown): Promise<unknown> {
    return this.context.transport.send("tab_page_assets_bundle", {
      browserId: this.context.browserId,
      tabId: this.context.tabId,
      options,
    });
  }
}

export function createCapabilityDefinitions(): Map<string, CapabilityDefinition> {
  const definitions: CapabilityDefinition[] = [
    { id: "visibility", scope: "browser", create: (ctx) => new VisibilityCapability(ctx, "visibility", "browser") },
    { id: "viewport", scope: "browser", create: (ctx) => new ViewportCapability(ctx, "viewport", "browser") },
    { id: "pageAssets", scope: "tab", create: (ctx) => new PageAssetsCapability(ctx, "pageAssets", "tab") },
  ];
  return new Map(definitions.map((definition) => [definition.id, definition]));
}

export class CapabilityCollection {
  constructor(private readonly options: {
    advertised: AdvertisedCapability[];
    browserId: string;
    definitions: Map<string, CapabilityDefinition>;
    scope: "browser" | "tab";
    tabId?: string;
    transport: BrowserTransport;
  }) {}
  async list(): Promise<AdvertisedCapability[]> {
    return this.options.advertised.filter((item) => {
      const definition = this.options.definitions.get(item.id);
      return definition?.scope === this.options.scope;
    });
  }
  async get(id: string): Promise<any> {
    const advertised = (await this.list()).some((item) => item.id === id);
    const definition = this.options.definitions.get(id);
    if (!advertised || !definition || definition.scope !== this.options.scope) {
      throw new Error(`Capability not available: ${id}`);
    }
    return definition.create({
      browserId: this.options.browserId,
      tabId: this.options.tabId,
      transport: this.options.transport,
    });
  }
}
```

The current extension descriptor must not advertise `cdp`, `browserAuth`, or `botDetection` in this
phase. Their definitions are added only in the plan that implements their callable methods.

- [ ] **Step 4: Replace the private generic capability classes in BrowserClient**

In `plugins/lume-chrome/src/client/BrowserClient.ts`:

1. Import `CapabilityCollection` and `createCapabilityDefinitions`.
2. Delete the existing private `CapabilityCollection`, `Capability`, and `PageAssetsCapability`.
3. Pass backend-advertised capability arrays and `browserId` into Browser and Tab constructors.
4. Remove direct `browser.visibility`, `browser.viewport`, and
   `tab.capabilities.pageAssets` properties. Access must be through `capabilities.get(id)`.

- [ ] **Step 5: Build and run focused tests**

Run:

```powershell
npm run build
node --test tests/capabilities.test.mjs tests/api-contract.test.mjs
```

Expected: 5 tests PASS.

- [ ] **Step 6: Commit typed capabilities**

```powershell
git add src/client/capabilities.ts src/client/BrowserClient.ts tests/capabilities.test.mjs
git commit -m "♻️ refactor(browser): 改用可调用 capability 对象" -m "删除非兼容的直挂能力入口，只有 backend 广告且存在定义的 capability 才可获取。`n`nConstraint: 延后能力不得由 backend 广告`nTested: npm run build; node --test tests/capabilities.test.mjs tests/api-contract.test.mjs"
```

## Task 6: Compose Effective Documentation

**Files:**
- Create: `plugins/lume-chrome/src/client/documentation.ts`
- Create: `plugins/lume-chrome/tests/documentation.test.mjs`
- Modify: `plugins/lume-chrome/src/client/BrowserClient.ts`

- [ ] **Step 1: Write conditional documentation tests**

Create `plugins/lume-chrome/tests/documentation.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserDocumentation,
  Documentation,
  formatApiReference,
  formatLookupCatalog,
} from "../dist/client/documentation.js";

const documents = new Map([
  ["browser-safety", "SAFETY"],
  ["api-use-behavior", "API USE"],
  ["tab-claiming-chrome", "CLAIM CHROME"],
  ["tab-cleanup-chrome", "FINALIZE CHROME"],
  ["file-uploads", "UPLOAD"],
  ["chrome-troubleshooting", "CHROME HELP"],
]);
const read = async (name) => {
  if (!documents.has(name)) throw new Error(`Unknown browser documentation: ${name}`);
  return documents.get(name);
};

test("extension guidance includes only supported and applicable documents", async () => {
  const docs = new BrowserDocumentation({
    api: async () => "API REFERENCE",
    browserType: "extension",
    capabilities: { browser: [], tab: [] },
    disabledMembers: new Set(),
    read,
  });
  const text = await docs.guidance();
  assert.match(text, /SAFETY/);
  assert.match(text, /CLAIM CHROME/);
  assert.match(text, /FINALIZE CHROME/);
  assert.match(text, /API USE/);
  assert.doesNotMatch(text, /UPLOAD/);
});

test("lookup catalog lists upload docs only when file chooser is supported", () => {
  const catalog = formatLookupCatalog({
    browserType: "extension",
    disabledMembers: new Set(),
  });
  assert.match(catalog, /file-uploads/);
  assert.match(catalog, /chrome-troubleshooting/);
  assert.doesNotMatch(formatLookupCatalog({
    browserType: "iab",
    disabledMembers: new Set(["PlaywrightFileChooser.setFiles"]),
  }), /file-uploads/);
});

test("effective API reference omits disabled members", () => {
  const api = formatApiReference(new Set(["Tab.getJsDialog", "Tabs.content"]));
  assert.match(api, /Tab\.goto/);
  assert.doesNotMatch(api, /Tab\.getJsDialog/);
  assert.doesNotMatch(api, /Tabs\.content/);
});

test("global documentation rejects traversal and extensions", async () => {
  const docs = new Documentation(read);
  assert.equal(await docs.get("browser-safety"), "SAFETY");
  await assert.rejects(() => docs.get("../browser-safety"), /relative path without an extension/);
  await assert.rejects(() => docs.get("browser-safety.md"), /relative path without an extension/);
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `npm run build; node --test tests/documentation.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `documentation.js`.

- [ ] **Step 3: Implement documentation composition**

Create `plugins/lume-chrome/src/client/documentation.ts` with:

```ts
import type { BrowserBackendType } from "./api-contract";
import { API_MEMBERS } from "./api-contract";

type ReadDocument = (name: string) => Promise<string>;

const SAFE_NAME = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/;

export class Documentation {
  constructor(private readonly read: ReadDocument) {}
  async get(name: string): Promise<string> {
    if (!SAFE_NAME.test(name)) throw new Error("Documentation name must be a relative path without an extension.");
    return await this.read(name);
  }
}

const included = [
  { name: "browser-safety" },
  { name: "api-use-behavior" },
  { name: "tab-claiming-chrome", browserType: "extension", member: "BrowserUser.claimTab" },
  { name: "tab-cleanup-chrome", browserType: "extension", member: "Tabs.finalize" },
] as const;

export function formatApiReference(disabledMembers: Set<string>): string {
  const sections = Object.entries(API_MEMBERS).map(([interfaceName, members]) => {
    const visible = members.filter((member) => !disabledMembers.has(`${interfaceName}.${member}`));
    return [`## ${interfaceName}`, ...visible.map((member) => `- \`${interfaceName}.${member}\``)].join("\n");
  });
  return ["# API Reference", ...sections].join("\n\n");
}

export function formatLookupCatalog(options: {
  browserType: BrowserBackendType;
  disabledMembers: Set<string>;
}): string {
  const entries = [
    { name: "confirmations", description: "read before browser confirmation" },
    { name: "browser-troubleshooting", description: "read after browser interaction failure" },
    ...(!options.disabledMembers.has("PlaywrightFileChooser.setFiles")
      ? [{ name: "file-uploads", description: "read before uploading files" }]
      : []),
    ...(options.browserType === "extension"
      ? [{ name: "chrome-troubleshooting", description: "read after Chrome connection failure" }]
      : []),
  ];
  return entries.map((entry) => `- ${entry.name}: ${entry.description}`).join("\n");
}

export class BrowserDocumentation extends Documentation {
  constructor(private readonly options: {
    api: () => Promise<string>;
    browserType: BrowserBackendType;
    capabilities: { browser: Array<{ id: string }>; tab: Array<{ id: string }> };
    disabledMembers: Set<string>;
    read: ReadDocument;
  }) {
    super(options.read);
  }
  api(): Promise<string> {
    return this.options.api();
  }
  async guidance(): Promise<string> {
    const names = included
      .filter((entry) => !entry.browserType || entry.browserType === this.options.browserType)
      .filter((entry) => !entry.member || !this.options.disabledMembers.has(entry.member))
      .map((entry) => entry.name);
    return (await Promise.all(names.map((name) => this.options.read(name)))).join("\n\n");
  }
  lookupCatalog(): string | undefined {
    const value = formatLookupCatalog(this.options);
    return value || undefined;
  }
}
```

Use a file reader rooted at `plugins/lume-chrome/docs` in setup code. Keep existing authored Lume
documents; do not copy Codex proprietary text. This phase's generated reference is an exact effective
member catalog. Callable TypeScript signatures are added alongside each object implementation in the
subsequent object-model plans, before that member can be advertised by a real backend.

- [ ] **Step 4: Wire Browser.documentation() to effective docs**

In `BrowserClient.ts`, create each `BrowserDocumentation` with
`api: async () => formatApiReference(disabledMembers)`. Change `Browser.documentation()` to
concatenate `BrowserDocumentation.guidance()`, `BrowserDocumentation.api()`, and lookup catalog. Do
not call the extension `browser_documentation` command for the effective public API.

- [ ] **Step 5: Run focused tests**

Run: `npm run build; node --test tests/documentation.test.mjs`

Expected: 4 tests PASS.

- [ ] **Step 6: Commit dynamic documentation**

```powershell
git add src/client/documentation.ts src/client/BrowserClient.ts tests/documentation.test.mjs
git commit -m "✨ feat(browser): 按有效能力生成浏览器文档" -m "浏览器类型和隐藏成员共同决定必读与按需文档，拒绝任意文档路径。`n`nConstraint: 不复制 Codex 专有文案`nTested: npm run build; node --test tests/documentation.test.mjs"
```

## Task 7: Integrate Discovery, Selection, Generation, And Agent Setup

**Files:**
- Modify: `plugins/lume-chrome/src/client/BrowserClient.ts`
- Modify: `plugins/lume-chrome/src/client/setupBrowserRuntime.ts`
- Modify: `plugins/lume-chrome/src/client/setupNodeReplBrowserRuntime.ts`
- Modify: `plugins/lume-chrome/src/extension/runtime/RuntimeDispatcher.ts`
- Modify: `plugins/lume-chrome/src/extension/runtime/NativeTransport.ts`
- Create: `plugins/lume-chrome/tests/client-conformance.test.mjs`
- Create: `plugins/lume-chrome/tests/native-transport-generation.test.mjs`

- [ ] **Step 1: Write the client conformance test**

Create `plugins/lume-chrome/tests/client-conformance.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { setupBrowserRuntime } from "../dist/client/setupBrowserRuntime.js";
import { createFakeBackend } from "./helpers/fake-browser-backend.mjs";

test("agent discovers, selects, documents, and invalidates browsers", async () => {
  const fake = createFakeBackend({
    id: "chrome-1",
    type: "extension",
    generation: 7,
    apiSupportOverrides: {
      "Tabs.content": false,
      "Tab.getJsDialog": false,
    },
    browserCapabilities: [{ id: "visibility", description: "Visibility" }],
    tabCapabilities: [{ id: "pageAssets", description: "Page assets" }],
  });
  fake.respond("browser_user_open_tabs", [{ id: "42", url: "https://example.com/" }]);
  fake.respond("list_tabs", [{ id: "42", url: "https://example.com/" }]);
  fake.respond("get_tab", { tabId: "42" });
  fake.respond("tab_url", "https://example.com/");

  const globals = {};
  const runtime = await setupBrowserRuntime({
    globals,
    transport: fake.transport,
    readDocument: async (name) => `DOC:${name}`,
  });

  assert.equal(globals.agent, runtime.agent);
  assert.equal((await runtime.agent.browsers.list())[0].id, "chrome-1");
  const browser = await runtime.agent.browsers.getForUrl("https://example.com/");
  assert.equal(browser.browserId, "chrome-1");
  assert.equal(browser.tabs.content, undefined);
  const tab = await browser.tabs.get("42");
  assert.equal(tab.getJsDialog, undefined);
  assert.equal(await tab.url(), "https://example.com/");
  assert.equal(tab.playwright.locator("button").and, undefined);
  assert.match(await browser.documentation(), /DOC:browser-safety/);

  fake.descriptor.generation = 8;
  await runtime.refreshBackends();
  await assert.rejects(tab.url(), /Browser object is stale/);
});

test("setup reuses an existing agent in the same kernel", async () => {
  const fake = createFakeBackend({ id: "iab-1", type: "iab" });
  const globals = {};
  const first = await setupBrowserRuntime({ globals, transport: fake.transport, readDocument: async () => "" });
  const second = await setupBrowserRuntime({ globals, transport: fake.transport, readDocument: async () => "" });
  assert.equal(second.agent, first.agent);
});
```

- [ ] **Step 2: Run the test and verify the API mismatch**

Run: `npm run build; node --test tests/client-conformance.test.mjs`

Expected: FAIL because `setupBrowserRuntime` still requires `context`, BrowserRegistry lacks
`getForUrl()`, the runtime has no internal refresh callback, and no generation guard exists.

- [ ] **Step 3: Refactor BrowserRegistry around backend descriptors**

In `BrowserClient.ts`:

- Cache descriptors from `runtime_list_browsers`.
- Add public `get(id)`, `getDefault()`, `getForUrl(url)`, and `list()` methods plus an internal
  refresh callback used by the runtime transport. Do not expose `refresh()` on `agent.browsers`.
- For `getForUrl()`, obtain open tab URLs only from candidate backend descriptors through one
  bounded `browser_user_open_tabs` call, then call `chooseBackendForUrl()`.
- Build `disabledMembersFor(descriptor.type, descriptor.apiSupportOverrides)`.
- Construct a raw Browser with descriptor, documentation, capability definitions, transport, and a
  closure returning the current generation.
- Return `createRuntimeView(disabled)(rawBrowser)`.
- Rename public constructors to their contract names so projection keys are exact:
  `Locator` to `PlaywrightLocator`, `Download` to `PlaywrightDownload`, `FileChooser` to
  `PlaywrightFileChooser`, and `ClipboardAPI` to `TabClipboardAPI`.
- Introduce `PlaywrightFrameLocator` as the return type of `PlaywrightAPI.frameLocator()` instead of
  returning another `PlaywrightAPI`. It exposes only frame locator builders from `API_MEMBERS`.

Add this guard to every command-bearing object through a shared base class:

```ts
class BrowserObject {
  constructor(
    protected readonly browserId: string,
    private readonly generation: number,
    private readonly currentGeneration: () => number | undefined,
  ) {}
  protected assertCurrent(): void {
    if (this.currentGeneration() !== this.generation) {
      throw new Error(`Browser object is stale: ${this.browserId}`);
    }
  }
}
```

Call `assertCurrent()` before transport sends. Locator builders may remain synchronous, but locator
actions and reads must guard before sending.

- [ ] **Step 4: Update setupBrowserRuntime**

Replace `setupBrowserRuntime.ts` with an idempotent setup accepting:

```ts
export interface SetupBrowserRuntimeOptions {
  globals?: Record<string, unknown>;
  transport: BrowserTransport;
  readDocument: (name: string) => Promise<string>;
}
```

It must install:

```ts
const agent = {
  browsers: new BrowserRegistry(options.transport, options.readDocument),
  documentation: new Documentation(options.readDocument),
};
```

Store the complete runtime under `Symbol.for("lume.browser.runtime")` on the supplied globals. If
that symbol already contains a runtime, return it instead of initializing a second agent. Return
`{ agent, refreshBackends }`, where `refreshBackends` updates the descriptor cache without becoming
a property of `agent`.

- [ ] **Step 5: Adapt the temporary Node REPL bridge**

In `setupNodeReplBrowserRuntime.ts`, keep the temporary WebSocket transport for the current Chrome
backend, but create the new agent through `setupBrowserRuntime()`. Supply a reader rooted at the
plugin `docs` directory. Do not add or expand `lumeBrowser.control.*`; its removal happens with the
Broker migration when the skill no longer depends on this bootstrap file.

- [ ] **Step 6: Return a complete extension descriptor**

In `RuntimeDispatcher.ts`, make both `runtime_ping` and `runtime_list_browsers` return descriptor
fields required by Task 2. The extension descriptor for this phase must advertise only capabilities
that are callable after Task 5:

```ts
{
  id: "extension",
  name: "Lume Chrome",
  type: "extension",
  protocolVersion: PROTOCOL_VERSION,
  generation: this.native.connectionGeneration(),
  metadata: {},
  capabilities: { browser: [], tab: [] },
  apiSupportOverrides: {
    "BrowserUser.history": false,
    "Tabs.content": false,
    "Tabs.finalize": false,
    "Tab.clipboard": false,
    "Tab.content": false,
    "Tab.cua": false,
    "Tab.dev": false,
    "Tab.dom_cua": false,
    "Tab.getJsDialog": false,
    "Tab.markDeliverable": false,
    "Tab.markHandoff": false,
    "Tab.playwright": false,
  },
}
```

These conservative overrides are intentional. Existing implementations whose parameter or return
shape differs from the compatibility contract remain callable only inside legacy implementation
code, not through the projected public BrowserClient. The Chrome object-model parity plan removes an
override only after its conformance test passes.

- [ ] **Step 7: Add and test monotonic native connection generation**

Create `tests/native-transport-generation.test.mjs` with a minimal Chrome mock:

```js
import assert from "node:assert/strict";
import test from "node:test";

test("native transport increments generation after every successful connection", async () => {
  const disconnectListeners = [];
  globalThis.chrome = {
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: {
      id: "test-extension",
      lastError: undefined,
      getManifest: () => ({ version: "0.4.0" }),
      connectNative: () => ({
        onMessage: { addListener() {} },
        onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
        postMessage() {},
      }),
    },
    storage: { local: { async set() {} } },
  };
  const { NativeTransport } = await import("../dist/extension/runtime/NativeTransport.js");
  const transport = new NativeTransport(async () => ({ jsonrpc: "2.0", id: "1", result: null }));
  assert.equal(transport.connectionGeneration(), 0);
  transport.connect();
  assert.equal(transport.connectionGeneration(), 1);
  disconnectListeners.shift()();
  transport.connect();
  assert.equal(transport.connectionGeneration(), 2);
  disconnectListeners.shift()();
  delete globalThis.chrome;
});
```

In `NativeTransport.ts`, add:

```ts
private generation = 0;
connectionGeneration(): number { return this.generation; }
```

Increment `generation` immediately after `chrome.runtime.connectNative()` returns a port and before
the hello request is sent. Do not increment when `connect()` returns early because a port already
exists or when `connectNative()` throws.

- [ ] **Step 8: Run conformance and bridge tests**

Run:

```powershell
npm run build
node --test tests/client-conformance.test.mjs tests/native-transport-generation.test.mjs tests/node-repl-bridge.test.mjs tests/runtime-dispatcher-response.test.mjs
```

Expected: all selected tests PASS. Existing facade tests may continue to pass through the temporary
adapter, but new conformance tests must use only `agent.browsers.*`.

- [ ] **Step 9: Commit integration**

```powershell
git add src/client/BrowserClient.ts src/client/setupBrowserRuntime.ts src/client/setupNodeReplBrowserRuntime.ts src/extension/runtime/RuntimeDispatcher.ts src/extension/runtime/NativeTransport.ts tests/client-conformance.test.mjs tests/native-transport-generation.test.mjs
git commit -m "✨ feat(browser): 接入动态后端发现与对象失效" -m "BrowserRegistry 依据描述符选择 backend，按 generation 拒绝旧对象，并保持临时 Chrome transport 可用。`n`nConstraint: 本阶段不引入 BrowserBroker`nTested: npm run build; node --test tests/client-conformance.test.mjs tests/native-transport-generation.test.mjs tests/node-repl-bridge.test.mjs tests/runtime-dispatcher-response.test.mjs"
```

## Task 8: Add Focused Scripts And Run The Phase Gate

**Files:**
- Modify: `plugins/lume-chrome/package.json`
- Modify: `plugins/lume-chrome/tests/plugin-packaging.test.mjs`
- Modify: `plugins/lume-chrome/docs/browser-api-matrix.md`

- [ ] **Step 1: Add a failing packaging assertion for the new public entry**

In `tests/plugin-packaging.test.mjs`, replace assertions that present
`lumeBrowser.control.*` as the public surface with:

```js
assert.match(skill, /setupBrowserRuntime|setupNodeReplBrowserRuntime/);
assert.match(skill, /agent\.browsers\.getForUrl/);
assert.match(skill, /agent\.browsers\.getDefault/);
assert.match(skill, /browser\.documentation\(\)/);
assert.doesNotMatch(skill, /lumeBrowser\.control/);
```

Also delete the old assertions requiring `tab.playwright.domSnapshot()` and
`tab.dom_cua.get_visible_dom()`. The effective extension descriptor hides those members in this
phase, so packaging tests must not force the skill to advertise them. Keep the negative assertions
that prohibit direct bridge state and invented tab helpers.

Replace the existing `browser API matrix documents the public surface` test body with:

```js
test("browser API matrix documents the projected compatibility surface", async () => {
  const matrix = await readText(join("docs", "browser-api-matrix.md"));
  assert.match(matrix, /Codex-compatible public contract/);
  assert.match(matrix, /dynamically hidden/);
  assert.match(matrix, /agent\.browsers\.getForUrl/);
  assert.match(matrix, /agent\.browsers\.getDefault/);
  assert.doesNotMatch(matrix, /lumeBrowser\.control/);
  assert.doesNotMatch(matrix, /webmcp.*implemented/i);
});
```

Do not remove the temporary implementation file yet. This step changes the documented Agent API,
not the transport migration scheduled for the BrowserBroker plan.

- [ ] **Step 2: Run the packaging test and verify it fails on old skill text**

Run: `npm run build; node --test tests/plugin-packaging.test.mjs`

Expected: FAIL because the skill still documents the high-level facade or omits the two selection
methods.

- [ ] **Step 3: Update focused scripts**

Add these scripts to `package.json`:

```json
"test:contract": "npm run build && node --test tests/api-contract.test.mjs tests/backend-descriptor.test.mjs tests/runtime-view.test.mjs tests/backend-selection.test.mjs tests/documentation.test.mjs tests/capabilities.test.mjs",
"test:conformance": "npm run build && node --test tests/client-conformance.test.mjs"
```

- [ ] **Step 4: Update skill and API matrix to the effective public surface**

Update `skills/control-browser/SKILL.md` and `docs/browser-api-matrix.md` so that they:

- initialize once and reuse `globalThis.agent`;
- call `agent.browsers.get("extension")` for explicit Chrome;
- call `agent.browsers.getForUrl(url)` when a URL is known and no backend is explicit;
- call `agent.browsers.getDefault()` when neither backend nor URL is known;
- read the complete `browser.documentation()` before interaction;
- never mention `lumeBrowser.control.*`, direct bridge state, hidden capabilities, or methods hidden
  by the current extension descriptor;
- state that `webmcp` is not public.

- [ ] **Step 5: Run the complete phase gate**

Run:

```powershell
npm run test:contract
npm run test:conformance
npm test
npm run check:coverage
git diff --check
```

Expected:

- contract tests PASS;
- conformance tests PASS;
- the existing complete plugin test suite PASS;
- command coverage reports an empty `missing` array;
- `git diff --check` produces no output.

- [ ] **Step 6: Commit documentation and scripts**

```powershell
git add package.json tests/plugin-packaging.test.mjs skills/control-browser/SKILL.md docs/browser-api-matrix.md
git commit -m "📝 docs(browser): 切换到统一浏览器公共入口" -m "Skill 和能力矩阵只描述动态有效 API，并加入契约与 conformance 快速门禁。`n`nConstraint: 旧 facade 不再作为 Agent 公共入口`nTested: npm run test:contract; npm run test:conformance; npm test; npm run check:coverage"
```

## Phase Completion Check

Before starting the BrowserBroker plan, verify all of the following:

- [ ] `agent.browsers.get/list/getDefault/getForUrl` work against the fake backend, and the internal
  runtime refresh invalidates stale objects.
- [ ] The extension backend still works through the temporary transport.
- [ ] Unsupported members are absent under property access and reflection.
- [ ] Only advertised, implemented capability objects can be obtained.
- [ ] Effective documentation excludes unsupported members and internal WebMCP.
- [ ] A backend generation change invalidates old browser objects locally.
- [ ] No new dependency appears in `package.json`.
- [ ] Existing dirty changes that predated execution remain preserved and attributable.
- [ ] The complete plugin suite and focused phase gates pass.

After this phase, write plan 2 for BrowserBroker and the opaque Node REPL transport using the program
order above.
