import { API_MEMBERS } from "./api-contract.js";
const CONSTRUCTOR_NAME_ALIASES = {
    BrowserRegistry: "Browsers",
    ClipboardAPI: "TabClipboardAPI",
    Download: "PlaywrightDownload",
    FileChooser: "PlaywrightFileChooser",
    Locator: "PlaywrightLocator",
};
export function createRuntimeView(disabled) {
    const rawToProxy = new WeakMap();
    const proxyToRaw = new WeakMap();
    const methodCache = new WeakMap();
    const prototypeCache = new WeakMap();
    function project(value) {
        if (!isObject(value))
            return value;
        if (proxyToRaw.has(value))
            return value;
        if (value instanceof Promise)
            return value.then((result) => project(result));
        if (Array.isArray(value))
            return value.map((item) => project(item));
        if (typeof value === "function")
            return value;
        const interfaceName = getInterfaceName(value);
        if (interfaceName)
            return proxyFor(value, interfaceName);
        return projectObjectFields(value);
    }
    function proxyFor(raw, interfaceName) {
        const cached = rawToProxy.get(raw);
        if (cached)
            return cached;
        const shadow = Object.create(sanitizedPrototypeFor(raw, interfaceName));
        const proxy = new Proxy(shadow, {
            get(target, property) {
                if (property === "__proto__")
                    return Reflect.getPrototypeOf(target);
                if (isHidden(interfaceName, property))
                    return undefined;
                const value = Reflect.get(raw, property, raw);
                if (typeof value === "function")
                    return methodFor(raw, property, value);
                return project(value);
            },
            has(_target, property) {
                return !isHidden(interfaceName, property) && Reflect.has(raw, property);
            },
            ownKeys() {
                return Reflect.ownKeys(raw).filter((property) => !isHidden(interfaceName, property));
            },
            getOwnPropertyDescriptor(_target, property) {
                if (isHidden(interfaceName, property))
                    return undefined;
                const descriptor = Reflect.getOwnPropertyDescriptor(raw, property);
                if (!descriptor)
                    return undefined;
                if (!("value" in descriptor))
                    return { ...descriptor, configurable: true };
                return { ...descriptor, configurable: true, value: project(descriptor.value) };
            },
            defineProperty() {
                return false;
            },
            preventExtensions() {
                return false;
            },
            setPrototypeOf() {
                return false;
            },
        });
        rawToProxy.set(raw, proxy);
        proxyToRaw.set(proxy, raw);
        return proxy;
    }
    function sanitizedPrototypeFor(raw, interfaceName) {
        const prototype = Object.getPrototypeOf(raw);
        if (prototype === null)
            return null;
        return sanitizedPrototype(prototype, interfaceName);
    }
    function sanitizedPrototype(prototype, interfaceName) {
        let cachedByInterface = prototypeCache.get(prototype);
        if (!cachedByInterface) {
            cachedByInterface = new Map();
            prototypeCache.set(prototype, cachedByInterface);
        }
        const cached = cachedByInterface.get(interfaceName);
        if (cached)
            return cached;
        const parent = Object.getPrototypeOf(prototype);
        const sanitized = Object.create(parent === null ? null : sanitizedPrototype(parent, interfaceName));
        cachedByInterface.set(interfaceName, sanitized);
        for (const property of Reflect.ownKeys(prototype)) {
            if (property === "constructor" || isHidden(interfaceName, property))
                continue;
            const descriptor = Reflect.getOwnPropertyDescriptor(prototype, property);
            if (descriptor)
                Object.defineProperty(sanitized, property, descriptor);
        }
        Object.preventExtensions(sanitized);
        return sanitized;
    }
    function methodFor(target, property, source) {
        let methods = methodCache.get(target);
        if (!methods) {
            methods = new Map();
            methodCache.set(target, methods);
        }
        const cached = methods.get(property);
        if (cached?.source === source)
            return cached.wrapper;
        const wrapper = (...args) => {
            return project(source.apply(target, args.map((arg) => unwrap(arg))));
        };
        methods.set(property, { source, wrapper });
        return wrapper;
    }
    function unwrap(value) {
        if (!isObject(value))
            return value;
        return proxyToRaw.get(value) ?? value;
    }
    function projectObjectFields(value) {
        let copy;
        for (const property of Reflect.ownKeys(value)) {
            const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
            if (!descriptor || !("value" in descriptor))
                continue;
            const projected = project(descriptor.value);
            if (projected === descriptor.value)
                continue;
            copy ??= cloneObject(value);
            Object.defineProperty(copy, property, { ...descriptor, value: projected });
        }
        return copy ?? value;
    }
    return project;
    function isHidden(interfaceName, property) {
        if (typeof property !== "string")
            return false;
        const members = API_MEMBERS[interfaceName];
        return !members.includes(property) || disabled.has(`${interfaceName}.${property}`);
    }
}
function getInterfaceName(value) {
    const constructorName = value.constructor?.name;
    const name = typeof constructorName === "string"
        ? CONSTRUCTOR_NAME_ALIASES[constructorName] ?? constructorName
        : null;
    return typeof name === "string" && Object.prototype.hasOwnProperty.call(API_MEMBERS, name)
        ? name
        : null;
}
function isObject(value) {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}
function cloneObject(value) {
    const copy = Object.create(Object.getPrototypeOf(value));
    for (const property of Reflect.ownKeys(value)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
        if (descriptor)
            Object.defineProperty(copy, property, descriptor);
    }
    return copy;
}
