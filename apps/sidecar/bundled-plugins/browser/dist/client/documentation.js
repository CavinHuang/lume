import { API_MEMBERS } from "./api-contract.js";
const SAFE_NAME = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/;
export class Documentation {
    read;
    constructor(read) {
        this.read = read;
    }
    async get(name) {
        if (!SAFE_NAME.test(name)) {
            throw new Error("Documentation name must be a relative path without an extension.");
        }
        return await this.read(name);
    }
}
const included = [
    { name: "browser-safety" },
    { name: "api-use-behavior" },
    { name: "tab-claiming-chrome", browserType: "extension", member: "BrowserUser.claimTab" },
    { name: "tab-cleanup-chrome", browserType: "extension", member: "Tabs.finalize" },
];
export function formatApiReference(disabledMembers) {
    const sections = Object.entries(API_MEMBERS).map(([interfaceName, members]) => {
        const visible = members.filter((member) => !disabledMembers.has(`${interfaceName}.${member}`));
        return [
            `## ${interfaceName}`,
            ...visible.map((member) => `- \`${interfaceName}.${member}\``),
        ].join("\n");
    });
    return ["# API Reference", ...sections].join("\n\n");
}
export function formatLookupCatalog(options) {
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
    options;
    constructor(options) {
        super(options.read);
        this.options = options;
    }
    api() {
        return this.options.api();
    }
    async guidance() {
        const names = included
            .filter((entry) => !entry.browserType || entry.browserType === this.options.browserType)
            .filter((entry) => !entry.member || !this.options.disabledMembers.has(entry.member))
            .map((entry) => entry.name);
        return (await Promise.all(names.map((name) => this.options.read(name)))).join("\n\n");
    }
    lookupCatalog() {
        const value = formatLookupCatalog(this.options);
        return value || undefined;
    }
}
