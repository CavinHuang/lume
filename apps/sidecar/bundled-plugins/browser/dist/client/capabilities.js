export class DocumentedCapability {
    context;
    id;
    scope;
    constructor(context, id, scope) {
        this.context = context;
        this.id = id;
        this.scope = scope;
    }
    documentation() {
        const method = this.scope === "browser"
            ? "browser_capability_documentation"
            : "tab_capability_documentation";
        return this.context.transport.send(method, {
            browserId: this.context.browserId,
            ...(this.context.tabId ? { tabId: this.context.tabId } : {}),
            capabilityId: this.id,
        });
    }
}
export class VisibilityCapability extends DocumentedCapability {
    get() {
        return this.context.transport.send("browser_visibility_get", {
            browserId: this.context.browserId,
        });
    }
    set(visible) {
        return this.context.transport.send("browser_visibility_set", {
            browserId: this.context.browserId,
            visible,
        });
    }
}
export class ViewportCapability extends DocumentedCapability {
    set(options) {
        return this.context.transport.send("browser_viewport_set", {
            browserId: this.context.browserId,
            options,
        });
    }
    reset() {
        return this.context.transport.send("browser_viewport_reset", {
            browserId: this.context.browserId,
        });
    }
}
export class PageAssetsCapability extends DocumentedCapability {
    list() {
        return this.context.transport.send("tab_page_assets_list", {
            browserId: this.context.browserId,
            tabId: this.context.tabId,
        });
    }
    bundle(options) {
        return this.context.transport.send("tab_page_assets_bundle", {
            browserId: this.context.browserId,
            tabId: this.context.tabId,
            options,
        });
    }
}
export class CdpCapability extends DocumentedCapability {
    send(method, params = {}, options = {}) {
        return this.context.transport.send("tab_cdp_send", {
            browserId: this.context.browserId,
            tabId: this.context.tabId,
            method,
            params,
            options,
        });
    }
    readEvents(options = {}) {
        return this.context.transport.send("tab_cdp_read_events", {
            browserId: this.context.browserId,
            tabId: this.context.tabId,
            options,
        });
    }
}
export class BotDetectionCapability extends DocumentedCapability {
    report(options) {
        return this.context.transport.send("tab_bot_detection_report", {
            browserId: this.context.browserId,
            tabId: this.context.tabId,
            reason: options.reason,
        });
    }
}
export class BrowserAuthCapability extends DocumentedCapability {
    request(options) {
        return this.context.transport.send("tab_browser_auth_request", {
            browserId: this.context.browserId,
            tabId: this.context.tabId,
            options: normalizeBrowserAuthOptions(options),
        });
    }
}
function normalizeBrowserAuthOptions(options) {
    return {
        ...options,
        fields: options.fields.map((field) => ({
            ...field,
            selector: normalizeBrowserAuthSelector(field.selector),
        })),
        ...(options.submit ? {
            submit: {
                ...options.submit,
                selector: normalizeBrowserAuthSelector(options.submit.selector),
            }
        } : {}),
    };
}
function normalizeBrowserAuthSelector(selector) {
    if (typeof selector === "string")
        return selector;
    if (selector && typeof selector === "object" && "ast" in selector) {
        return selector.ast;
    }
    return selector;
}
export function createCapabilityDefinitions() {
    const definitions = [
        {
            id: "visibility",
            scope: "browser",
            create: (context) => new VisibilityCapability(context, "visibility", "browser"),
        },
        {
            id: "viewport",
            scope: "browser",
            create: (context) => new ViewportCapability(context, "viewport", "browser"),
        },
        {
            id: "pageAssets",
            scope: "tab",
            create: (context) => new PageAssetsCapability(context, "pageAssets", "tab"),
        },
        {
            id: "cdp",
            scope: "tab",
            create: (context) => new CdpCapability(context, "cdp", "tab"),
        },
        {
            id: "botDetection",
            scope: "tab",
            create: (context) => new BotDetectionCapability(context, "botDetection", "tab"),
        },
        {
            id: "browserAuth",
            scope: "tab",
            create: (context) => new BrowserAuthCapability(context, "browserAuth", "tab"),
        },
    ];
    return new Map(definitions.map((definition) => [definition.id, definition]));
}
export class CapabilityCollection {
    options;
    constructor(options) {
        this.options = options;
    }
    async list() {
        return this.options.advertised.filter((item) => {
            const definition = this.options.definitions.get(item.id);
            return definition?.scope === this.options.scope;
        });
    }
    async get(id) {
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
