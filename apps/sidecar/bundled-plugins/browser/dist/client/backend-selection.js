export function isLocalBrowserUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol === "file:")
            return true;
        if (url.protocol !== "http:" && url.protocol !== "https:")
            return false;
        const host = url.hostname.toLowerCase();
        if (host === "localhost" || host === "::1" || host === "[::1]")
            return true;
        const octets = host.split(".").map(Number);
        return octets.length === 4
            && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
            && octets[0] === 127;
    }
    catch {
        return false;
    }
}
export function chooseDefaultBackend(backends) {
    const selected = backends.find((backend) => backend.type === "iab");
    if (!selected)
        throw new Error("No browser is available");
    return selected;
}
function comparableUrl(value) {
    try {
        const url = new URL(value);
        url.hash = "";
        return url;
    }
    catch {
        return null;
    }
}
export function chooseBackendForUrl(backends, value, preferredType) {
    const target = comparableUrl(value);
    if (!target)
        throw new Error(`Invalid browser URL: ${value}`);
    const selectedType = preferredType ?? "iab";
    const candidates = backends.filter((backend) => backend.type === selectedType);
    const matching = candidates.find((backend) => backend.openTabUrls.some((candidate) => {
        const open = comparableUrl(candidate);
        return open?.href === target.href
            || (open?.origin === target.origin && open.pathname === target.pathname)
            || open?.hostname === target.hostname;
    }));
    const selected = matching ?? candidates[0];
    if (!selected)
        throw new Error(`No ${selectedType} browser is available for ${target.href}`);
    return selected;
}
