import { appendLocator, locatorAst } from "../shared/locator.js";
import { disabledMembersFor } from "./api-contract.js";
import { chooseBackendForUrl, chooseDefaultBackend, } from "./backend-selection.js";
import { CapabilityCollection, createCapabilityDefinitions } from "./capabilities.js";
import { BrowserDocumentation, formatApiReference, } from "./documentation.js";
import { createRuntimeView } from "./runtime-view.js";
const CAPABILITY_DEFINITIONS = createCapabilityDefinitions();
const EMPTY_DOCUMENT_READER = async () => "";
const DEFAULT_CONTEXT = {
    browserSessionId: "browser-runtime",
    browserTurnId: "browser-runtime",
    actor: "agent",
};
const REGISTRY_REFRESHERS = new WeakMap();
export class JsonRpcTransport {
    post;
    seq = 1;
    constructor(post) {
        this.post = post;
    }
    async send(method, params) {
        const id = String(this.seq++);
        const response = await this.post({ jsonrpc: "2.0", id, method, params });
        if ("error" in response) {
            const err = new Error(response.error.message);
            err.code = response.error.code;
            err.details = response.error.details;
            err.recoverable = response.error.recoverable;
            throw err;
        }
        return response.result;
    }
}
export class BrowserRegistry {
    transport;
    context;
    readDocument;
    descriptors = new Map();
    constructor(transport, contextOrReader, readDocument = EMPTY_DOCUMENT_READER) {
        this.transport = transport;
        this.context = typeof contextOrReader === "function" ? DEFAULT_CONTEXT : contextOrReader;
        this.readDocument = typeof contextOrReader === "function" ? contextOrReader : readDocument;
        REGISTRY_REFRESHERS.set(this, async () => {
            await this.refreshDescriptors();
        });
    }
    async get(id = "extension") {
        const response = await this.transport.send("runtime_ping", {
            clientType: id,
            context: this.context,
        });
        const descriptor = normalizePingDescriptor(response, id);
        this.descriptors.set(descriptor.id, descriptor);
        return this.createBrowser(descriptor);
    }
    async getDefault() {
        const descriptors = await this.ensureDescriptors();
        return this.createBrowser(chooseDefaultBackend(asSelectable(descriptors)));
    }
    async getForUrl(value) {
        const descriptors = await this.ensureDescriptors();
        const selectable = asSelectable(descriptors);
        // URL choice is always IAB by default. External Chrome is selected only
        // through the explicit get("extension")/backend path.
        return this.createBrowser(chooseBackendForUrl(selectable, value, "iab"));
    }
    async list() {
        return await this.refreshDescriptors();
    }
    diagnostics() {
        return this.transport.send("runtime_diagnostics", { context: this.context });
    }
    async ensureDescriptors() {
        return this.descriptors.size > 0
            ? [...this.descriptors.values()]
            : await this.refreshDescriptors();
    }
    async refreshDescriptors() {
        const descriptors = await this.transport.send("runtime_list_browsers", { context: this.context });
        this.descriptors.clear();
        for (const descriptor of descriptors)
            this.descriptors.set(descriptor.id, descriptor);
        return [...this.descriptors.values()];
    }
    createBrowser(descriptor) {
        const disabledMembers = disabledMembersFor(descriptor.type, descriptor.apiSupportOverrides);
        const documentation = new BrowserDocumentation({
            api: async () => formatApiReference(disabledMembers),
            browserType: descriptor.type,
            capabilities: descriptor.capabilities,
            disabledMembers,
            read: this.readDocument,
        });
        const transport = guardedTransport(this.transport, descriptor, () => this.descriptors.get(descriptor.id)?.generation);
        const browser = new Browser(transport, this.context, descriptor, documentation);
        return createRuntimeView(disabledMembers)(browser);
    }
}
export async function refreshBrowserRegistry(registry) {
    const refresh = REGISTRY_REFRESHERS.get(registry);
    if (!refresh)
        throw new Error("Unknown browser registry");
    await refresh();
}
function asSelectable(descriptors) {
    return descriptors.map((descriptor) => ({ ...descriptor, openTabUrls: [] }));
}
function normalizePingDescriptor(value, requestedId) {
    const type = value.type ?? value.clientType ?? requestedType(requestedId);
    const minSupported = value.minSupported ?? value.protocolVersion ?? 0;
    const maxSupported = value.maxSupported ?? value.protocolVersion ?? 0;
    if (maxSupported < 5 || minSupported > 5) {
        const error = new Error("incompatible_protocol");
        error.code = "incompatible_protocol";
        throw error;
    }
    return {
        id: value.id ?? value.browserId ?? requestedId,
        name: value.name ?? `Lume ${type}`,
        type,
        protocolVersion: value.protocolVersion ?? 0,
        ...(value.minSupported !== undefined ? { minSupported: value.minSupported } : {}),
        ...(value.maxSupported !== undefined ? { maxSupported: value.maxSupported } : {}),
        ...(value.capabilityHash ? { capabilityHash: value.capabilityHash } : {}),
        generation: value.generation ?? 0,
        metadata: value.metadata ?? {},
        capabilities: value.capabilities ?? { browser: [], tab: [] },
        apiSupportOverrides: value.apiSupportOverrides ?? {},
    };
}
function requestedType(value) {
    return value === "iab" || value === "cdp" ? value : "extension";
}
function historyTime(value) {
    if (value === undefined)
        return undefined;
    const time = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(time) ? time : undefined;
}
function guardedTransport(transport, descriptor, currentGeneration) {
    const assertCurrent = () => {
        if (currentGeneration() !== descriptor.generation) {
            throw new Error(`Browser object is stale: ${descriptor.id}`);
        }
    };
    return {
        async send(method, params) {
            assertCurrent();
            const routed = isRecord(params) ? { ...params, browserId: descriptor.id } : params;
            return await transport.send(method, routed);
        },
        notify(method, params) {
            assertCurrent();
            const routed = isRecord(params) ? { ...params, browserId: descriptor.id } : params;
            transport.notify?.(method, routed);
        },
    };
}
export class Browser {
    t;
    ctx;
    info;
    docs;
    browserId;
    user;
    tabs;
    capabilities;
    constructor(t, ctx, info, docs) {
        this.t = t;
        this.ctx = ctx;
        this.info = info;
        this.docs = docs;
        this.browserId = info.id;
        this.user = new BrowserUser(t, ctx, info);
        this.tabs = new Tabs(t, ctx, info);
        this.capabilities = new CapabilityCollection({
            advertised: info.capabilities.browser,
            browserId: info.id,
            definitions: CAPABILITY_DEFINITIONS,
            scope: "browser",
            transport: t,
        });
    }
    async documentation() {
        const [guidance, api] = await Promise.all([this.docs.guidance(), this.docs.api()]);
        return [guidance, api, this.docs.lookupCatalog()]
            .map((part) => part?.trim())
            .filter(Boolean)
            .join("\n\n");
    }
    nameSession(name) { return this.t.send("browser_name_session", { context: this.ctx, name }); }
    sitePermissions = {
        list: () => this.t.send("browser_site_permissions_list", { context: this.ctx }),
        allowForSession: (host) => this.t.send("browser_site_permission_set", { context: this.ctx, host, decision: "allow_session" }),
        alwaysAllow: (host) => this.t.send("browser_site_permission_set", { context: this.ctx, host, decision: "allow_always" }),
        block: (host) => this.t.send("browser_site_permission_set", { context: this.ctx, host, decision: "block" }),
        clear: (host) => this.t.send("browser_site_permission_clear", { context: this.ctx, host })
    };
}
export class BrowserUser {
    t;
    ctx;
    browser;
    constructor(t, ctx, browser) {
        this.t = t;
        this.ctx = ctx;
        this.browser = browser;
    }
    openTabs() { return this.t.send("browser_user_open_tabs", { context: this.ctx }); }
    async claimTab(tab) {
        const tabId = typeof tab === "string" ? tab : tab.id;
        const result = await this.t.send("browser_user_claim_tab", { context: this.ctx, tabId });
        return new Tab(this.t, this.ctx, result.tabId, this.browser);
    }
    async history(options = {}) {
        const query = options.queries?.filter(Boolean).join(" ") ?? "";
        const commandOptions = {
            text: query,
        };
        if (typeof options.limit === "number")
            commandOptions.maxResults = options.limit;
        const startTime = historyTime(options.from);
        const endTime = historyTime(options.to);
        if (startTime !== undefined)
            commandOptions.startTime = startTime;
        if (endTime !== undefined)
            commandOptions.endTime = endTime;
        const entries = await this.t.send("browser_user_history", {
            context: this.ctx,
            options: commandOptions,
        });
        return entries.flatMap((entry) => entry.url
            ? [{
                    url: entry.url,
                    ...(entry.title ? { title: entry.title } : {}),
                    dateVisited: new Date(entry.lastVisitTime ?? 0).toISOString(),
                }]
            : []);
    }
    topSites() { return this.t.send("top_sites_get", { context: this.ctx }); }
    recentSessions() { return this.t.send("sessions_get_recently_closed", { context: this.ctx }); }
}
export class Tabs {
    t;
    ctx;
    browser;
    constructor(t, ctx, browser) {
        this.t = t;
        this.ctx = ctx;
        this.browser = browser;
    }
    async new(options = {}) {
        const r = await this.t.send("create_tab", { context: this.ctx, options });
        return new Tab(this.t, this.ctx, r.tabId, this.browser);
    }
    async get(id) {
        const r = await this.t.send("get_tab", { context: this.ctx, tabId: id });
        return new Tab(this.t, this.ctx, r.tabId, this.browser);
    }
    async selected() {
        const r = await this.t.send("selected_tab", { context: this.ctx });
        return r.tabId ? new Tab(this.t, this.ctx, r.tabId, this.browser) : undefined;
    }
    list() { return this.t.send("list_tabs", { context: this.ctx }); }
    sessionTabs() { return this.t.send("get_session_tabs", { context: this.ctx }); }
    finalize(options = {}) { return this.t.send("finalize_tabs", { context: this.ctx, keep: options.keep ?? [] }); }
    release(tabIds) { return this.t.send("release_tabs", { context: this.ctx, tabIds }); }
    handoff(tabIds) { return this.t.send("handoff_tabs", { context: this.ctx, tabIds }); }
    resumeHandoff() {
        return this.t.send("resume_handoff_tabs", { context: this.ctx })
            .then(xs => xs.map(x => new Tab(this.t, this.ctx, x.tabId, this.browser)));
    }
}
export class Tab {
    t;
    ctx;
    id;
    cua;
    dom_cua;
    playwright;
    capabilities;
    clipboard;
    content;
    dev;
    constructor(t, ctx, id, browser) {
        this.t = t;
        this.ctx = ctx;
        this.id = id;
        this.cua = new CUAAPI(t, ctx, id);
        this.dom_cua = new DomCUAAPI(t, ctx, id);
        this.playwright = new PlaywrightAPI(t, ctx, id);
        this.content = new ContentAPI(t, ctx, id);
        this.capabilities = new CapabilityCollection({
            advertised: browser.capabilities.tab,
            browserId: browser.id,
            definitions: CAPABILITY_DEFINITIONS,
            scope: "tab",
            tabId: id,
            transport: t,
        });
        this.clipboard = new TabClipboardAPI(t, ctx, id);
        this.dev = new TabDevAPI(t, ctx, id);
    }
    close() { return this.t.send("close_tab", { context: this.ctx, tabId: this.id }); }
    title() { return this.t.send("tab_title", { context: this.ctx, tabId: this.id }); }
    url() { return this.t.send("tab_url", { context: this.ctx, tabId: this.id }); }
    goto(url, options = {}) {
        return this.t.send("navigate_tab_url", { context: this.ctx, tabId: this.id, url, options });
    }
    back() { return this.t.send("navigate_tab_back", { context: this.ctx, tabId: this.id }); }
    forward() { return this.t.send("navigate_tab_forward", { context: this.ctx, tabId: this.id }); }
    reload() { return this.t.send("navigate_tab_reload", { context: this.ctx, tabId: this.id }); }
    async getJsDialog() {
        const info = await this.t.send("tab_js_dialog_get", {
            context: this.ctx,
            tabId: this.id,
        });
        return info ? createDialog(this.t, this.ctx, this.id, info) : undefined;
    }
    screenshot(options = {}) {
        return this.t.send("tab_screenshot", { context: this.ctx, tabId: this.id, options })
            .then((result) => Uint8Array.from(atob(result.dataBase64), c => c.charCodeAt(0)));
    }
    exportContent(options) {
        return this.t.send(options.format === "gsuite" ? "tab_content_export_gsuite" : "tab_content_export", { context: this.ctx, tabId: this.id, options });
    }
    markDeliverable(reason) { return this.finalizeAs("deliverable", reason); }
    markHandoff(reason) { return this.finalizeAs("handoff", reason); }
    finalizeAs(status, reason) {
        const keep = { tabId: this.id, status };
        if (reason)
            keep.reason = reason;
        return this.t.send("finalize_tabs", { context: this.ctx, keep: [keep] });
    }
}
function createDialog(t, ctx, tabId, info) {
    const handle = (options) => t.send("tab_js_dialog_handle", {
        context: ctx,
        tabId,
        ...options,
    });
    const base = {
        ...info,
        dismiss: () => handle({ accept: false }),
    };
    if (info.type === "confirm") {
        return { ...base, accept: () => handle({ accept: true }) };
    }
    if (info.type === "prompt") {
        return { ...base, accept: (text) => handle({ accept: true, promptText: text }) };
    }
    return base;
}
class ContentAPI {
    t;
    ctx;
    tabId;
    constructor(t, ctx, tabId) {
        this.t = t;
        this.ctx = ctx;
        this.tabId = tabId;
    }
    async export() {
        const result = await this.t.send("tab_content_export", {
            context: this.ctx,
            tabId: this.tabId,
            options: { format: "markdown" },
        });
        return result.path ?? result.assetId;
    }
    async exportGsuite(type) {
        const result = await this.t.send("tab_content_export_gsuite", {
            context: this.ctx,
            tabId: this.tabId,
            type,
        });
        return result.path ?? result.assetId;
    }
}
class TabDevAPI {
    t;
    ctx;
    tabId;
    constructor(t, ctx, tabId) {
        this.t = t;
        this.ctx = ctx;
        this.tabId = tabId;
    }
    cdpCall(method, params, allowMutating = false) {
        return this.t.send("tab_cdp_call", { context: this.ctx, tabId: this.tabId, method, params, allowMutating });
    }
    subscribe(events) { return this.t.send("tab_cdp_events", { context: this.ctx, tabId: this.tabId, events }); }
    logs(options = {}) { return this.t.send("tab_dev_logs", { context: this.ctx, tabId: this.tabId, options }); }
}
class CUAAPI {
    t;
    ctx;
    tabId;
    constructor(t, ctx, tabId) {
        this.t = t;
        this.ctx = ctx;
        this.tabId = tabId;
    }
    click(options) { return this.t.send("cua_click", { context: this.ctx, tabId: this.tabId, ...options }); }
    double_click(options) { return this.t.send("cua_double_click", { context: this.ctx, tabId: this.tabId, ...options }); }
    move(options) { return this.t.send("cua_move", { context: this.ctx, tabId: this.tabId, ...options }); }
    drag(options) { return this.t.send("cua_drag", { context: this.ctx, tabId: this.tabId, ...options }); }
    scroll(options) { return this.t.send("cua_scroll", { context: this.ctx, tabId: this.tabId, ...options }); }
    type(options) { return this.t.send("cua_type", { context: this.ctx, tabId: this.tabId, ...options }); }
    keypress(options) { return this.t.send("cua_keypress", { context: this.ctx, tabId: this.tabId, ...options }); }
    downloadMedia(options) { return this.t.send("cua_download_media", { context: this.ctx, tabId: this.tabId, ...options }); }
}
class DomCUAAPI {
    t;
    ctx;
    tabId;
    constructor(t, ctx, tabId) {
        this.t = t;
        this.ctx = ctx;
        this.tabId = tabId;
    }
    get_visible_dom() { return this.t.send("dom_cua_get_visible_dom", { context: this.ctx, tabId: this.tabId }); }
    click(options) { return this.t.send("dom_cua_click", { context: this.ctx, tabId: this.tabId, ...options }); }
    double_click(options) { return this.t.send("dom_cua_double_click", { context: this.ctx, tabId: this.tabId, ...options }); }
    type(options) { return this.t.send("dom_cua_type", { context: this.ctx, tabId: this.tabId, ...options }); }
    keypress(options) { return this.t.send("dom_cua_keypress", { context: this.ctx, tabId: this.tabId, ...options }); }
    scroll(options) { return this.t.send("dom_cua_scroll", { context: this.ctx, tabId: this.tabId, ...options }); }
    downloadMedia(options) { return this.t.send("dom_cua_download_media", { context: this.ctx, tabId: this.tabId, ...options }); }
}
export class PlaywrightFrameLocator {
    t;
    ctx;
    tabId;
    frameSteps;
    constructor(t, ctx, tabId, frameSteps) {
        this.t = t;
        this.ctx = ctx;
        this.tabId = tabId;
        this.frameSteps = frameSteps;
    }
    frameLocator(frameSelector) {
        return new PlaywrightFrameLocator(this.t, this.ctx, this.tabId, [...this.frameSteps, { kind: "frame", selector: frameSelector }]);
    }
    locator(selector) { return this.make({ kind: "locator", selector }); }
    getByRole(role, options = {}) { return this.make({ kind: "role", role, ...options }); }
    getByText(text, options = {}) { return this.make({ kind: "text", text, ...options }); }
    getByLabel(text, options = {}) { return this.make({ kind: "label", text, ...options }); }
    getByPlaceholder(text, options = {}) { return this.make({ kind: "placeholder", text, ...options }); }
    getByTestId(testId) { return this.make({ kind: "testId", testId }); }
    make(step) {
        return new PlaywrightLocator(this.t, this.ctx, this.tabId, locatorAst(...this.frameSteps, step));
    }
}
export class PlaywrightAPI extends PlaywrightFrameLocator {
    constructor(t, ctx, tabId) {
        super(t, ctx, tabId, []);
    }
    domSnapshot() { return this.t.send("playwright_dom_snapshot", { context: this.ctx, tabId: this.tabId }); }
    evaluate(expression, arg) {
        return this.t.send("playwright_evaluate", { context: this.ctx, tabId: this.tabId, expression, arg });
    }
    async expectNavigation(action, options = {}) {
        const result = await action();
        if (options.url)
            await this.waitForURL(options.url, { timeoutMs: options.timeoutMs });
        else
            await this.waitForLoadState({ state: options.waitUntil === "commit" ? "domcontentloaded" : options.waitUntil ?? "load", timeoutMs: options.timeoutMs });
        return result;
    }
    waitForURL(url, options = {}) { return this.t.send("playwright_wait_for_url", { context: this.ctx, tabId: this.tabId, url, options }); }
    waitForLoadState(options = {}) { return this.t.send("playwright_wait_for_load_state", { context: this.ctx, tabId: this.tabId, ...options }); }
    waitForTimeout(timeoutMs) { return this.t.send("playwright_wait_for_timeout", { context: this.ctx, tabId: this.tabId, timeoutMs }); }
    elementInfo(options) {
        return this.t.send("playwright_element_info", {
            context: this.ctx,
            tabId: this.tabId,
            options,
        });
    }
    elementScreenshot(options) {
        return this.t.send("playwright_element_screenshot", {
            context: this.ctx,
            tabId: this.tabId,
            options,
        }).then((result) => Uint8Array.from(atob(result.dataBase64), c => c.charCodeAt(0)));
    }
    async waitForEvent(event, options = {}) {
        if (event === "download") {
            const info = await this.t.send("playwright_wait_for_download", { context: this.ctx, tabId: this.tabId, options });
            return new PlaywrightDownload(this.t, this.ctx, info);
        }
        const info = await this.t.send("playwright_wait_for_file_chooser", { context: this.ctx, tabId: this.tabId, options });
        return new PlaywrightFileChooser(this.t, this.ctx, this.tabId, info);
    }
}
export class PlaywrightLocator {
    t;
    ctx;
    tabId;
    ast;
    constructor(t, ctx, tabId, ast) {
        this.t = t;
        this.ctx = ctx;
        this.tabId = tabId;
        this.ast = ast;
    }
    first() { return this.with({ kind: "first" }); }
    last() { return this.with({ kind: "last" }); }
    nth(index) { return this.with({ kind: "nth", index }); }
    filter(options) { return this.with({ kind: "filter", ...options }); }
    and(locator) { return this.with({ kind: "and", locator: locator.ast }); }
    or(locator) { return this.with({ kind: "or", locator: locator.ast }); }
    locator(selector) { return this.with({ kind: "locator", selector }); }
    getByRole(role, options = {}) { return this.with({ kind: "role", role, ...options }); }
    getByText(text, options = {}) { return this.with({ kind: "text", text, ...options }); }
    getByLabel(text, options = {}) { return this.with({ kind: "label", text, ...options }); }
    getByPlaceholder(text, options = {}) { return this.with({ kind: "placeholder", text, ...options }); }
    getByTestId(testId) { return this.with({ kind: "testId", testId }); }
    click(options = {}) { return this.send("playwright_locator_click", options); }
    dblclick(options = {}) { return this.send("playwright_locator_dblclick", options); }
    hover(options = {}) { return this.send("playwright_locator_hover", options); }
    scroll(deltaY, deltaX = 0, options = {}) { return this.send("playwright_locator_scroll", { ...options, deltaX, deltaY }); }
    fill(value, options = {}) { return this.send("playwright_locator_fill", { ...options, text: value }); }
    press(key, options = {}) { return this.send("playwright_locator_press", { ...options, key }); }
    type(value, options = {}) { return this.send("playwright_locator_type", { ...options, text: value }); }
    selectOption(value, options = {}) { return this.send("playwright_locator_select_option", { ...options, value }); }
    setChecked(checked, options = {}) { return this.send("playwright_locator_set_checked", { ...options, checked }); }
    check(options = {}) { return this.send("playwright_locator_check", options); }
    uncheck(options = {}) { return this.send("playwright_locator_uncheck", options); }
    getAttribute(name, options = {}) { return this.send("playwright_locator_get_attribute", { ...options, name }); }
    innerText(options = {}) { return this.send("playwright_locator_inner_text", options); }
    textContent(options = {}) { return this.send("playwright_locator_text_content", options); }
    inputValue(options = {}) { return this.send("playwright_locator_input_value", options); }
    isVisible() { return this.send("playwright_locator_is_visible", {}); }
    isEnabled() { return this.send("playwright_locator_is_enabled", {}); }
    isChecked() { return this.send("playwright_locator_is_checked", {}); }
    count() { return this.send("playwright_locator_count", {}); }
    allTextContents(options = {}) { return this.send("playwright_locator_all_text_contents", options); }
    readAll(options = {}) { return this.send("playwright_locator_read_all", options); }
    async all() { const count = await this.count(); return Array.from({ length: count }, (_, index) => this.nth(index)); }
    waitFor(options = {}) { return this.send("playwright_locator_wait_for", options); }
    downloadMedia() { return this.send("playwright_locator_download_media", {}); }
    with(step) { return new PlaywrightLocator(this.t, this.ctx, this.tabId, appendLocator(this.ast, step)); }
    send(method, extra) {
        const payload = { locator: this.ast, ...extra };
        return this.t.send(method, { context: this.ctx, tabId: this.tabId, ...payload });
    }
}
export class PlaywrightFileChooser {
    t;
    ctx;
    tabId;
    info;
    constructor(t, ctx, tabId, info) {
        this.t = t;
        this.ctx = ctx;
        this.tabId = tabId;
        this.info = info;
    }
    isMultiple() { return this.info.multiple; }
    accept() { return this.info.accept; }
    setFiles(files) {
        return this.t.send("playwright_file_chooser_set_files", { context: this.ctx, tabId: this.tabId, chooserId: this.info.chooserId, files });
    }
}
export class PlaywrightDownload {
    t;
    ctx;
    info;
    constructor(t, ctx, info) {
        this.t = t;
        this.ctx = ctx;
        this.info = info;
    }
    suggestedFilename() { return this.info.filename?.split(/[\\/]/).pop(); }
    path() {
        return this.t.send("playwright_download_path", { context: this.ctx, downloadId: this.info.downloadId }).then(r => r.path);
    }
}
class TabClipboardAPI {
    t;
    ctx;
    tabId;
    constructor(t, ctx, tabId) {
        this.t = t;
        this.ctx = ctx;
        this.tabId = tabId;
    }
    read() { return this.t.send("tab_clipboard_read", { context: this.ctx, tabId: this.tabId }); }
    readText() { return this.t.send("tab_clipboard_read_text", { context: this.ctx, tabId: this.tabId }); }
    write(data) { return this.t.send("tab_clipboard_write", { context: this.ctx, tabId: this.tabId, data }); }
    writeText(text) { return this.t.send("tab_clipboard_write_text", { context: this.ctx, tabId: this.tabId, text }); }
}
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
