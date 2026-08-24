import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { builtinModules, createRequire, isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import { inspect, TextDecoder, TextEncoder } from "node:util";
import { fileURLToPath, pathToFileURL, URL, URLSearchParams } from "node:url";
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";
import { buildCellSource } from "./cell-source.js";
if (!parentPort)
    throw new Error("CUA runtime worker requires a parent port");
const parent = parentPort;
const options = workerData;
const cwd = path.resolve(options.cwd);
const sessionId = options.sessionId ?? crypto.randomUUID();
const internalSalt = sessionId.replace(/[^A-Za-z0-9_$]/g, "_") || "session";
let internalCounter = 0;
const permissions = new Set(options.manifest.permissions ?? []);
const fullEnv = freezeEnv(options.env);
const untrustedEnv = freezeEnv(pickEnvironment(options.env, options.manifest.allowedEnv ?? []));
const trustedCodePaths = (options.trustedCodePaths ?? []).map((entry) => canonicalPath(path.resolve(entry)));
const browserClientPath = trustedCodePaths.find((entry) => path.basename(entry) === "browser-client.mjs");
const trustedSourceHashes = new Set((options.trustedSourceHashes ?? []).map(normalizeHash));
const execStorage = new AsyncLocalStorage();
const spanStorage = new AsyncLocalStorage();
const pendingCalls = new Map();
const nativeConnections = new Map();
const pendingNativePipeClosures = new Map();
let callCounter = 0;
let privilegedRequestCounter = 0;
let emitImageCounter = 0;
let elicitationCounter = 0;
let authenticatedFetchCounter = 0;
let nativePipeRequestCounter = 0;
const bridgeToken = options.bridgeToken;
let activeExecId = null;
let currentRequestMeta = null;
let currentFormElicitationSupported = false;
let previousModule = null;
let previousBindings = [];
let cellCounter = 0;
let executionQueue = Promise.resolve();
let fatalExitScheduled = false;
function createRuntimeContext(kind) {
    const context = vm.createContext({}, {
        name: `lume-cua:${kind}:${options.manifest.name}`,
        codeGeneration: kind === "trusted" ? { strings: false } : { strings: false, wasm: false },
    });
    const target = context;
    target.globalThis = context;
    target.global = context;
    target.Buffer = Buffer;
    target.console = console;
    target.URL = URL;
    target.URLSearchParams = URLSearchParams;
    target.TextEncoder = TextEncoder;
    target.TextDecoder = TextDecoder;
    if (typeof AbortController !== "undefined")
        target.AbortController = AbortController;
    if (typeof AbortSignal !== "undefined")
        target.AbortSignal = AbortSignal;
    if (typeof structuredClone !== "undefined")
        target.structuredClone = structuredClone;
    if (typeof fetch !== "undefined")
        target.fetch = fetch;
    if (typeof Headers !== "undefined")
        target.Headers = Headers;
    if (typeof Request !== "undefined")
        target.Request = Request;
    if (typeof Response !== "undefined")
        target.Response = Response;
    target.performance = performance;
    target.crypto = crypto.webcrypto;
    target.setTimeout = setTimeout;
    target.clearTimeout = clearTimeout;
    target.setInterval = setInterval;
    target.clearInterval = clearInterval;
    target.setImmediate = setImmediate;
    target.clearImmediate = clearImmediate;
    target.queueMicrotask = queueMicrotask;
    target.atob = (data) => Buffer.from(data, "base64").toString("binary");
    target.btoa = (data) => Buffer.from(data, "binary").toString("base64");
    return context;
}
const untrustedContext = createRuntimeContext("untrusted");
const trustedContext = createRuntimeContext("trusted");
function defineLockedGlobal(context, name, value) {
    Object.defineProperty(context, name, { value, writable: false, configurable: false, enumerable: false });
}
function getAsyncExecState() {
    const state = execStorage.getStore();
    if (!state?.id)
        throw new Error("node_repl exec context not found");
    return state;
}
function getCurrentExecState() {
    const state = getAsyncExecState();
    if (state.id !== activeExecId)
        throw new Error("node_repl exec context not found");
    return state;
}
function requirePermission(permission) {
    if (!permissions.has(permission))
        throw new Error(`Runtime permission denied: ${permission}`);
}
function hostCall(method, args, state = getAsyncExecState()) {
    const callId = `call-${++callCounter}`;
    parent.postMessage({ type: "host-call", callId, execId: state.id, method, args, bridgeToken });
    return new Promise((resolve, reject) => pendingCalls.set(callId, { resolve, reject }));
}
function hostEvent(method, args, state = getAsyncExecState()) {
    parent.postMessage({ type: "host-event", execId: state.id, method, args, bridgeToken });
}
function sendNativePipeRequest(op, payload = {}, state = getAsyncExecState()) {
    const id = `native-pipe-${nativePipeRequestCounter++}`;
    return hostCall("nativePipe.request", {
        type: "native_pipe_request",
        id,
        op,
        ...payload,
    }, state);
}
function createNativePipeConnection(id, execState, closed = false, error = null) {
    const state = {
        id,
        execState,
        listeners: { data: new Set(), close: new Set(), error: new Set() },
        closed,
        error,
    };
    if (!closed)
        nativeConnections.set(id, state);
    return Object.freeze({
        write(data) {
            if (state.closed)
                return;
            state.execState = getAsyncExecState();
            const dataBase64 = nativePipeBytesToBase64(data);
            void sendNativePipeRequest("write", { connection_id: id, data_base64: dataBase64 }, state.execState).catch((writeError) => {
                closeNativePipeState(state, writeError instanceof Error ? writeError : new Error(String(writeError)));
            });
        },
        on(event, listener) {
            validateNativePipeEvent(event);
            if (typeof listener !== "function")
                throw new Error("native pipe event listener must be a function");
            const alreadyListening = state.listeners[event].has(listener);
            state.listeners[event].add(listener);
            if (alreadyListening)
                return;
            if (event === "error" && state.error)
                queueNativePipeListener(listener, state.error);
            if (event === "close" && state.closed)
                queueNativePipeListener(listener);
        },
        off(event, listener) {
            validateNativePipeEvent(event);
            state.listeners[event].delete(listener);
        },
        end() {
            void sendNativePipeRequest("close", { connection_id: id }, state.execState).catch(() => undefined);
        },
    });
}
function handleNativePipeData(state, data) {
    execStorage.run(state.execState, () => {
        for (const listener of state.listeners.data)
            listener(data);
    });
}
function closeNativePipeState(state, error) {
    if (state.closed)
        return;
    state.closed = true;
    state.error = error;
    nativeConnections.delete(state.id);
    if (error) {
        execStorage.run(state.execState, () => {
            for (const listener of state.listeners.error)
                queueNativePipeListener(listener, error);
        });
    }
    execStorage.run(state.execState, () => {
        for (const listener of state.listeners.close)
            queueNativePipeListener(listener);
    });
}
function validateNativePipeEvent(event) {
    if (event !== "data" && event !== "close" && event !== "error") {
        throw new Error(`unsupported native pipe event: ${String(event)}`);
    }
}
function queueNativePipeListener(listener, ...args) {
    void Promise.resolve().then(() => listener(...args)).catch(() => undefined);
}
function nativePipeBytesToBase64(data) {
    if (Buffer.isBuffer(data))
        return data.toString("base64");
    if (ArrayBuffer.isView(data))
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
    if (data instanceof ArrayBuffer)
        return Buffer.from(data).toString("base64");
    throw new Error("native pipe write expected bytes");
}
function makeRejectedThenable(error) {
    const promise = Promise.reject(error);
    return {
        then: promise.then.bind(promise),
        catch: promise.catch.bind(promise),
        finally: promise.finally.bind(promise),
    };
}
function trackBackground(state, operation) {
    const observation = { observed: false };
    const tracked = operation.then(() => ({ ok: true, error: null, observation }), (error) => ({ ok: false, error, observation }));
    state.pendingBackgroundTasks.add(tracked);
    return {
        then(onFulfilled, onRejected) {
            observation.observed = true;
            return operation.then(onFulfilled, onRejected);
        },
        catch(onRejected) {
            observation.observed = true;
            return operation.catch(onRejected ?? undefined);
        },
        finally(onFinally) {
            observation.observed = true;
            return operation.finally(onFinally ?? undefined);
        },
    };
}
async function drainBackgroundTasks(state) {
    while (state.pendingBackgroundTasks.size > 0) {
        const tasks = [...state.pendingBackgroundTasks];
        state.pendingBackgroundTasks.clear();
        const results = await Promise.all(tasks);
        const unhandled = results.find((result) => !result.ok && !result.observation.observed);
        if (unhandled)
            throw unhandled.error;
    }
}
function formatLog(values) {
    return values.map((value) => typeof value === "string" ? value : inspect(value, { depth: 4, colors: false })).join(" ");
}
function renderOutput(events) {
    let output = "";
    for (const event of events) {
        output += event.text;
        if (event.kind === "line")
            output += "\n";
    }
    if (events.at(-1)?.kind === "line" && output.endsWith("\n"))
        output = output.slice(0, -1);
    return output;
}
function capturedConsole(state) {
    const line = (...values) => state.outputEvents.push({ kind: "line", text: formatLog(values) });
    return { ...console, log: line, info: line, warn: line, error: line, debug: line };
}
function isPlainObject(value) {
    // Codex uses a deliberately loose definition here: any truthy, non-array
    // object is accepted. Preserve that behavior even for Date/Map instances.
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value))
        return value;
    Object.freeze(value);
    for (const child of Object.values(value))
        deepFreeze(child);
    return value;
}
function normalizeResponseMeta(value) {
    if (!isPlainObject(value))
        throw new Error("nodeRepl.setResponseMeta expected a plain object");
    return structuredClone(value);
}
function toByteArray(value) {
    if (value instanceof Uint8Array || Buffer.isBuffer(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    if (ArrayBuffer.isView(value))
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
}
function sniffMime(bytes) {
    if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value))
        return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return "image/jpeg";
    if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP")
        return "image/webp";
    throw new Error("nodeRepl.emitImage could not infer image MIME type from bytes; expected PNG, JPEG, or WebP data");
}
function encodeImage(bytes, mimeType) {
    if (bytes.byteLength === 0)
        throw new Error("nodeRepl.emitImage expected non-empty bytes");
    if (typeof mimeType !== "string" || !mimeType)
        throw new Error("nodeRepl.emitImage expected a non-empty mimeType");
    return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}
function normalizeImage(value) {
    if (typeof value === "string") {
        if (!value)
            throw new Error("nodeRepl.emitImage expected a non-empty image_url");
        if (!/^data:/i.test(value))
            throw new Error("nodeRepl.emitImage only accepts data URLs");
        return value;
    }
    const directBytes = toByteArray(value);
    if (directBytes)
        return encodeImage(directBytes, sniffMime(directBytes));
    if (isPlainObject(value) && "bytes" in value) {
        if (Object.keys(value).some((key) => key !== "bytes" && key !== "mimeType"))
            throw new Error("nodeRepl.emitImage received an unsupported value");
        const bytes = toByteArray(value.bytes);
        if (!bytes)
            throw new Error("nodeRepl.emitImage expected bytes to be Buffer, Uint8Array, ArrayBuffer, or ArrayBufferView");
        return encodeImage(bytes, value.mimeType);
    }
    throw new Error("nodeRepl.emitImage received an unsupported value");
}
function privilegedOperation(operationName, buildArgs) {
    let state;
    try {
        state = getCurrentExecState();
    }
    catch (error) {
        return makeRejectedThenable(error);
    }
    const operation = (async () => {
        const request = await buildArgs();
        let hostArgs = request.args;
        if (request.method === "config.action" && isPlainObject(request.args)) {
            hostArgs = {
                type: "config_action",
                ...request.args,
                id: `${state.id}-privileged-node-repl-${privilegedRequestCounter++}`,
                exec_id: state.id,
            };
        }
        try {
            return await hostCall(request.method, hostArgs, state);
        }
        catch (error) {
            throw new Error(error instanceof Error ? error.message : `${operationName} failed`);
        }
    })();
    return trackBackground(state, operation);
}
const baseNodeRepl = Object.freeze({
    cwd,
    env: untrustedEnv,
    homeDir: options.env.HOME ?? null,
    tmpDir: os.tmpdir(),
    get requestMeta() { return currentRequestMeta; },
    write(text) {
        const state = getCurrentExecState();
        if (typeof text !== "string")
            throw new Error("nodeRepl.write expected a string");
        state.outputEvents.push({ kind: "write", text });
    },
    setResponseMeta(meta) {
        const state = getCurrentExecState();
        const normalized = normalizeResponseMeta(meta);
        // The real node_repl crosses a JSONL boundary at this point. Validate and
        // normalize the outbound value here so cyclic objects/BigInt fail inside
        // the active cell instead of crashing the kernel process later. Keep the
        // raw merged value for subsequent same-cell merges (for example Date).
        const nextMeta = state.responseMeta ? { ...state.responseMeta, ...normalized } : normalized;
        const encoded = JSON.stringify({ type: "response_meta", id: state.id, response_meta: nextMeta });
        const outbound = JSON.parse(encoded).response_meta;
        state.responseMeta = nextMeta;
        parent.postMessage({ type: "response-meta", id: state.id, responseMeta: outbound });
    },
    emitImage(imageLike) {
        let state;
        try {
            state = getCurrentExecState();
        }
        catch (error) {
            return makeRejectedThenable(error);
        }
        const operation = (async () => {
            const imageUrl = normalizeImage(await imageLike);
            const id = `${state.id}-emit-image-${emitImageCounter++}`;
            return hostCall("emitImage", { id, execId: state.id, imageUrl }, state);
        })();
        return trackBackground(state, operation);
    },
});
const configBridge = Object.freeze({
    readToml(pathValue) {
        return privilegedOperation("nodeRepl.config.readToml", async () => ({ method: "config.action", args: { action: "read_toml", path: normalizeNonEmptyString(await pathValue, "nodeRepl TOML path") } }));
    },
    writeToml(pathValue, value) {
        return privilegedOperation("nodeRepl.config.writeToml", async () => {
            const tomlPath = normalizeNonEmptyString(await pathValue, "nodeRepl TOML path");
            if (tomlPath.toLowerCase() === "config.toml")
                throw new Error("nodeRepl.config.writeToml does not allow writing ~/.codex/config.toml; use nodeRepl.config.writeValue or nodeRepl.config.batchWrite");
            const resolvedValue = await value;
            if (!isPlainObject(resolvedValue))
                throw new Error("nodeRepl TOML value must be a plain object");
            return { method: "config.action", args: { action: "write_toml", path: tomlPath, value: structuredClone(resolvedValue) } };
        });
    },
    read(optionsValue) {
        return privilegedOperation("nodeRepl.config.read", async () => {
            const resolved = await optionsValue;
            if (resolved !== undefined && !isPlainObject(resolved))
                throw new Error("nodeRepl.config.read options must be an object");
            const record = isPlainObject(resolved) ? resolved : {};
            if (record.cwd != null && typeof record.cwd !== "string")
                throw new Error("nodeRepl.config.read cwd must be a string or null");
            if (record.includeLayers !== undefined && typeof record.includeLayers !== "boolean")
                throw new Error("nodeRepl.config.read includeLayers must be a boolean");
            return { method: "config.action", args: { action: "read_config", cwd: record.cwd, include_layers: record.includeLayers ?? false } };
        });
    },
    readRequirements() {
        return privilegedOperation("nodeRepl.config.readRequirements", async () => ({ method: "config.action", args: { action: "read_config_requirements" } }));
    },
    writeValue(requestValue) {
        return privilegedOperation("nodeRepl.config.writeValue", async () => ({ method: "config.action", args: normalizeConfigWriteRequest(await requestValue, "nodeRepl.config.writeValue", "write_config_value") }));
    },
    batchWrite(requestValue) {
        return privilegedOperation("nodeRepl.config.batchWrite", async () => {
            const request = await requestValue;
            if (!isPlainObject(request))
                throw new Error("nodeRepl.config.batchWrite request must be an object");
            if (!Array.isArray(request.edits) || request.edits.length === 0)
                throw new Error("nodeRepl.config.batchWrite edits must be a non-empty array");
            if (request.reloadUserConfig !== undefined && typeof request.reloadUserConfig !== "boolean")
                throw new Error("nodeRepl.config.batchWrite reloadUserConfig must be a boolean");
            return {
                method: "config.action",
                args: {
                    action: "batch_write_config",
                    edits: request.edits.map((edit) => normalizeConfigEditRequest(edit, "nodeRepl.config.batchWrite")),
                    expected_version: normalizeExpectedVersion(request.expectedVersion, "nodeRepl.config.batchWrite"),
                    reload_user_config: request.reloadUserConfig ?? false,
                },
            };
        });
    },
});
const launchServicesBridge = Object.freeze({
    openApplication(targetValue) {
        return privilegedOperation("nodeRepl.launchServices.openApplication", async () => {
            const target = await targetValue;
            if (!isPlainObject(target))
                throw new Error("nodeRepl.launchServices.openApplication expected a target object");
            if (Object.keys(target).some((key) => key !== "applicationPath" && key !== "bundleIdentifier"))
                throw new Error("nodeRepl.launchServices.openApplication received an unsupported target");
            const applicationPath = nonEmptyString(target.applicationPath);
            const bundleIdentifier = nonEmptyString(target.bundleIdentifier);
            if ((applicationPath == null) === (bundleIdentifier == null))
                throw new Error("nodeRepl.launchServices.openApplication expected exactly one of applicationPath or bundleIdentifier");
            const id = `${getCurrentExecState().id}-privileged-node-repl-${privilegedRequestCounter++}`;
            return {
                method: "launchServices.openApplication",
                args: {
                    type: "launch_services_action",
                    action: "open_application",
                    application_path: applicationPath,
                    bundle_identifier: bundleIdentifier,
                    id,
                    exec_id: getCurrentExecState().id,
                },
            };
        });
    },
});
const nativePipeBridge = Object.freeze({
    async createConnection(pipePathValue) {
        const state = getCurrentExecState();
        const pipePath = await pipePathValue;
        if (typeof pipePath !== "string" || pipePath.length === 0)
            throw new Error("native pipe path must be a non-empty string");
        const result = await sendNativePipeRequest("connect", { path: pipePath }, state);
        const connectionId = result?.connection_id ?? result?.connectionId;
        if (!connectionId)
            throw new Error("native pipe connect returned an invalid connection id");
        const hasPendingClose = pendingNativePipeClosures.has(connectionId);
        const pendingError = pendingNativePipeClosures.get(connectionId) ?? null;
        pendingNativePipeClosures.delete(connectionId);
        return createNativePipeConnection(connectionId, state, hasPendingClose, pendingError);
    },
});
const browserAuthBridge = Object.freeze({
    request(requestValue) {
        let state;
        try {
            state = getCurrentExecState();
        }
        catch (error) {
            return makeRejectedThenable(error);
        }
        const operation = (async () => {
            const request = await requestValue;
            if (!isPlainObject(request))
                throw new Error("nodeRepl.browserAuth.request expected a request object");
            return hostCall("browserAuth.request", structuredClone(request), state);
        })();
        return trackBackground(state, operation);
    },
});
const browserBridge = Object.freeze({
    request(methodValue, paramsValue = {}) {
        let state;
        try {
            state = getCurrentExecState();
        }
        catch (error) {
            return makeRejectedThenable(error);
        }
        const operation = (async () => {
            requirePermission("browser");
            const method = await methodValue;
            const params = await paramsValue;
            if (typeof method !== "string" || !method.trim())
                throw new Error("nodeRepl.browser.request expected a method");
            if (!isPlainObject(params))
                throw new Error("nodeRepl.browser.request expected params to be an object");
            return hostCall("browser.request", { method, params: structuredClone(params) }, state);
        })();
        return trackBackground(state, operation);
    },
});
const telemetryBridge = options.responseMetaTrace ? createTelemetryBridge() : undefined;
const privilegedProperties = {
    launchServices: { value: launchServicesBridge, enumerable: true, writable: false, configurable: false },
    config: { value: configBridge, enumerable: true, writable: false, configurable: false },
    browserAuth: { value: browserAuthBridge, enumerable: true, writable: false, configurable: false },
    browser: { value: browserBridge, enumerable: true, writable: false, configurable: false },
    env: { value: fullEnv, enumerable: true, writable: false, configurable: false },
    createElicitation: {
        enumerable: true, writable: false, configurable: false,
        value(requestValue) {
            let state;
            try {
                state = getCurrentExecState();
                if (!currentFormElicitationSupported)
                    throw new Error("nodeRepl.createElicitation is unavailable because the MCP client does not support form elicitation");
            }
            catch (error) {
                return makeRejectedThenable(error);
            }
            const operation = (async () => {
                const request = await requestValue;
                if (!isPlainObject(request))
                    throw new Error("nodeRepl.createElicitation expected a request object");
                if (Object.keys(request).some((key) => !["message", "meta", "requestedSchema"].includes(key)))
                    throw new Error("nodeRepl.createElicitation received an unsupported value");
                if (typeof request.message !== "string" || !request.message.trim())
                    throw new Error("nodeRepl.createElicitation expected a non-empty message");
                if (request.meta != null && !isPlainObject(request.meta))
                    throw new Error("nodeRepl.createElicitation meta must be an object");
                const id = `${state.id}-elicitation-${elicitationCounter++}`;
                const response = await hostCall("elicitation", {
                    type: "elicit",
                    id,
                    exec_id: state.id,
                    message: request.message,
                    requested_schema: structuredClone(request.requestedSchema ?? { type: "object", properties: {} }),
                    meta: request.meta == null ? null : structuredClone(request.meta),
                }, state);
                return {
                    action: response?.action,
                    content: response?.content ?? null,
                    _meta: response?._meta ?? null,
                };
            })();
            return trackBackground(state, operation);
        },
    },
    fetch: {
        enumerable: true, writable: false, configurable: false,
        value(input, init) {
            let state;
            try {
                state = getAsyncExecState();
            }
            catch (error) {
                return makeRejectedThenable(error);
            }
            const promise = (async () => {
                if (typeof Request !== "function" || typeof Response !== "function") {
                    throw new Error("nodeRepl.fetch requires Request and Response globals");
                }
                const request = new Request(await input, init);
                const body = Buffer.from(await request.arrayBuffer());
                const requestPayload = {
                    method: request.method,
                    url: request.url,
                    headers: Array.from(request.headers.entries()).map(([name, value]) => ({ name, value })),
                };
                if (body.length > 0)
                    requestPayload.body_base64 = body.toString("base64");
                const id = `${state.id}-authenticated-fetch-${authenticatedFetchCounter++}`;
                const rawResponse = await hostCall("authenticatedFetch", {
                    type: "authenticated_fetch",
                    id,
                    exec_id: state.id,
                    request: requestPayload,
                }, state);
                if (!rawResponse || typeof rawResponse !== "object")
                    throw new Error("nodeRepl.fetch did not return a response");
                const response = rawResponse;
                const status = Number(response.status);
                const responseBody = response.body_base64 && ![204, 205, 304].includes(status)
                    ? Buffer.from(response.body_base64, "base64")
                    : null;
                return new Response(responseBody, {
                    status,
                    statusText: response.status_text ?? "",
                    headers: (response.headers ?? []).map((header) => [header.name, header.value]),
                });
            })();
            void promise.catch(() => undefined);
            return promise;
        },
    },
    nativePipe: { value: nativePipeBridge, enumerable: true, writable: false, configurable: false },
    withSuspendedTimeout: {
        enumerable: true, writable: false, configurable: false,
        value(fn) {
            let state;
            try {
                state = getCurrentExecState();
                if (typeof fn !== "function")
                    throw new Error("nodeRepl.withSuspendedTimeout expected a function");
            }
            catch (error) {
                return makeRejectedThenable(error);
            }
            const operation = (async () => {
                hostEvent("timeout.suspend", {}, state);
                try {
                    return await fn();
                }
                finally {
                    hostEvent("timeout.resume", {}, state);
                }
            })();
            return trackBackground(state, operation);
        },
    },
};
if (telemetryBridge)
    privilegedProperties.telemetry = { value: telemetryBridge, enumerable: true, writable: false, configurable: false };
if (permissions.has("computerUse")) {
    privilegedProperties.computer = {
        enumerable: true, writable: false, configurable: false,
        value: Object.freeze({ request(method, params) { return privilegedOperation("nodeRepl.computer.request", async () => ({ method: "computer.request", args: { method, params: params ?? null } })); } }),
    };
}
const trustedNodeRepl = Object.freeze(Object.create(baseNodeRepl, privilegedProperties));
const rootNodeRepl = options.exposePrivilegedToRoot ? trustedNodeRepl : baseNodeRepl;
defineLockedGlobal(untrustedContext, "nodeRepl", rootNodeRepl);
defineLockedGlobal(untrustedContext, "tmpDir", os.tmpdir());
defineLockedGlobal(trustedContext, "nodeRepl", trustedNodeRepl);
defineLockedGlobal(trustedContext, "tmpDir", os.tmpdir());
// Agent tool bridge: `await tools.Name(params)` routes the call through the
// host so normal permission checks apply; `await tools.documentation()`
// returns the tool catalog. Reserved names bypass tool dispatch.
const TOOLS_RESERVED = new Set(["call", "documentation", "then"]);
function toolsOperation(run) {
    let state;
    try {
        state = getCurrentExecState();
    }
    catch (error) {
        return makeRejectedThenable(error);
    }
    return trackBackground(state, Promise.resolve().then(() => run(state)));
}
function toolsCall(name, params) {
    return toolsOperation((state) => (async () => {
        const toolName = normalizeNonEmptyString(name, "tools tool name");
        const resolved = params ?? {};
        if (!isPlainObject(resolved))
            throw new Error("tools call params must be an object");
        const result = await hostCall("tool_call", { name: toolName, params: structuredClone(resolved) }, state);
        const content = typeof result?.content === "string" ? result.content : JSON.stringify(result);
        if (result?.is_error)
            throw new Error(content);
        return content;
    })());
}
const toolsBridge = new Proxy({}, {
    get(_target, prop) {
        if (typeof prop !== "string")
            return undefined;
        if (prop === "call")
            return toolsCall;
        if (prop === "documentation")
            return () => toolsOperation((state) => hostCall("tool_list", {}, state).then((r) => String(r?.documentation ?? "")));
        if (TOOLS_RESERVED.has(prop))
            return undefined;
        return (params) => toolsCall(prop, params);
    },
});
defineLockedGlobal(untrustedContext, "tools", toolsBridge);
defineLockedGlobal(trustedContext, "tools", toolsBridge);
class ModuleLoader {
    fileModules = new Map();
    nativeModules = new Map();
    moduleLinks = new Map();
    moduleLinkTails = new Map();
    moduleEvaluations = new Map();
    moduleSearchBases = [];
    constructor() {
        for (const entry of options.moduleDirs ?? [])
            this.addModuleDir(entry);
        this.addModuleDir(cwd);
    }
    clearLocalCache() {
        this.fileModules.clear();
        this.moduleLinks.clear();
        this.moduleLinkTails.clear();
        this.moduleEvaluations.clear();
    }
    addModuleDir(entry) {
        const trimmed = entry.trim();
        if (!trimmed)
            return;
        const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
        const base = path.basename(resolved) === "node_modules" ? path.dirname(resolved) : resolved;
        if (this.moduleSearchBases.includes(base))
            return;
        const cwdIndex = this.moduleSearchBases.indexOf(cwd);
        if (cwdIndex === -1)
            this.moduleSearchBases.push(base);
        else
            this.moduleSearchBases.splice(cwdIndex, 0, base);
    }
    resolveToUrl(specifier, referrerIdentifier) {
        const resolved = this.resolve(specifier, referrerIdentifier);
        if (resolved.kind === "builtin")
            return resolved.specifier;
        if (resolved.kind === "file")
            return pathToFileURL(resolved.path).href;
        return resolved.specifier;
    }
    async dynamicImport(specifier, referrerIdentifier, referrerTrusted) {
        const resolved = this.resolve(specifier, referrerIdentifier);
        // #634 已知边界：bare package 经 importNative 在宿主 realm 执行（npm 包
        // 的 CJS 依赖树无法进 ESM module 图），vm 隔离对包导入面不生效——
        // 完整收编需 CJS shim 或换隔离原语，见 issue #634 跟进。
        if (resolved.kind !== "file")
            return this.importNative(resolved);
        const trusted = referrerTrusted || await isTrustedFile(resolved.path);
        const module = await this.loadLinkedFileModule(resolved.path, trusted);
        const key = this.cacheKey(resolved.path, trusted ? "trusted" : "untrusted");
        let evaluation = this.moduleEvaluations.get(key);
        if (!evaluation) {
            evaluation = module.evaluate();
            this.moduleEvaluations.set(key, evaluation);
        }
        await evaluation;
        return module.namespace;
    }
    async link(specifier, referrer, referrerTrusted) {
        return this.loadLinkedModule(this.resolve(specifier, referrer.identifier), referrerTrusted);
    }
    getOrCreateFileModule(modulePath, trusted) {
        const kind = trusted ? "trusted" : "untrusted";
        const key = this.cacheKey(modulePath, kind);
        const cached = this.fileModules.get(key);
        if (cached)
            return cached;
        const context = trusted ? trustedContext : untrustedContext;
        const source = fsSync.readFileSync(modulePath, "utf8");
        const module = new vm.SourceTextModule(source, {
            context,
            identifier: modulePath,
            initializeImportMeta: (meta, mod) => this.setImportMeta(meta, mod, false),
            importModuleDynamically: ((childSpecifier, referrer) => this.dynamicImport(childSpecifier, referrer.identifier, trusted)),
        });
        this.fileModules.set(key, module);
        return module;
    }
    async loadLinkedFileModule(modulePath, trusted) {
        const kind = trusted ? "trusted" : "untrusted";
        const key = this.cacheKey(modulePath, kind);
        const module = this.getOrCreateFileModule(modulePath, trusted);
        let linking = this.moduleLinks.get(key);
        if (!linking) {
            const previousLinking = this.moduleLinkTails.get(kind) ?? Promise.resolve();
            linking = previousLinking.then(async () => {
                if (module.status === "unlinked") {
                    await module.link((specifier, referrer) => this.loadLinkedModule(this.resolve(specifier, referrer.identifier), trusted));
                }
            });
            this.moduleLinks.set(key, linking);
            this.moduleLinkTails.set(kind, linking.catch(() => undefined));
        }
        await linking;
        return module;
    }
    async loadLinkedModule(resolved, trusted) {
        if (resolved.kind === "file")
            return this.getOrCreateFileModule(resolved.path, trusted);
        return this.loadNativeModule(resolved, trusted);
    }
    async importNative(resolved) {
        if (resolved.kind === "builtin")
            return import(resolved.specifier);
        return import(pathToFileURL(resolved.path).href);
    }
    async loadNativeModule(resolved, trusted) {
        const kind = trusted ? "trusted" : "untrusted";
        const cacheId = resolved.kind === "builtin" ? `builtin:${resolved.specifier}` : `package:${resolved.path}`;
        const key = this.cacheKey(cacheId, kind);
        let modulePromise = this.nativeModules.get(key);
        if (!modulePromise) {
            modulePromise = (async () => {
                const namespace = await this.importNative(resolved);
                const names = Object.getOwnPropertyNames(namespace);
                return new vm.SyntheticModule(names, function initialize() {
                    for (const name of names)
                        this.setExport(name, namespace[name]);
                }, { context: trusted ? trustedContext : untrustedContext });
            })();
            this.nativeModules.set(key, modulePromise);
        }
        return modulePromise;
    }
    resolve(specifier, referrerIdentifier) {
        if (typeof specifier !== "string" || !specifier || specifier.trim() !== specifier) {
            throw new Error(`Unsupported import specifier "${String(specifier)}" in node_repl. Use a package name like "lodash" or "@scope/pkg", or a relative/absolute/file:// .js/.mjs path.`);
        }
        if (specifier.startsWith("node:") || isBuiltin(specifier) || builtinModules.includes(specifier)) {
            const normalized = specifier.startsWith("node:") ? specifier : `node:${specifier}`;
            // Single choke point for every import path (dynamic import, static
            // link, nested untrusted imports all funnel through resolve()).
            if (!isTrustedReferrer(referrerIdentifier) && !ALLOWED_BUILTIN_MODULES.has(normalized)) {
                throw new Error(`Importing module "${specifier}" is not allowed in node_repl cells. Allowed builtin modules: ${[...ALLOWED_BUILTIN_MODULES].map((name) => name.replace(/^node:/, "")).join(", ")}`);
            }
            return { kind: "builtin", specifier: normalized };
        }
        if (isPathSpecifier(specifier))
            return this.resolvePathSpecifier(specifier, referrerIdentifier);
        if (!isBarePackageSpecifier(specifier)) {
            throw new Error(`Unsupported import specifier "${specifier}" in node_repl. Use a package name like "lodash" or "@scope/pkg", or a relative/absolute/file:// .js/.mjs path.`);
        }
        const resolvedPath = this.resolveBareSpecifier(specifier);
        if (!resolvedPath)
            throw new Error(`Module not found: ${specifier}`);
        return { kind: "package", path: resolvedPath, specifier };
    }
    setImportMeta(meta, mod, isMain) {
        const target = meta;
        target.url = pathToFileURL(mod.identifier).href;
        target.filename = mod.identifier;
        target.dirname = path.dirname(mod.identifier);
        target.main = isMain;
        target.resolve = (specifier) => this.resolveToUrl(specifier, mod.identifier);
    }
    resolvePathSpecifier(specifier, referrerIdentifier) {
        let candidate;
        if (specifier.startsWith("file:")) {
            try {
                candidate = fileURLToPath(new URL(specifier));
            }
            catch (error) {
                throw new Error(`Failed to resolve module "${specifier}": ${formatErrorMessage(error)}`);
            }
        }
        else {
            const baseDirectory = referrerIdentifier && path.isAbsolute(referrerIdentifier) ? path.dirname(referrerIdentifier) : cwd;
            candidate = path.isAbsolute(specifier) ? specifier : path.resolve(baseDirectory, specifier);
        }
        let resolvedPath;
        try {
            resolvedPath = fsSync.realpathSync.native(candidate);
        }
        catch (error) {
            if (error.code === "ENOENT")
                throw new Error(`Module not found: ${specifier}`);
            throw new Error(`Failed to resolve module "${specifier}": ${formatErrorMessage(error)}`);
        }
        let stats;
        try {
            stats = fsSync.statSync(resolvedPath);
        }
        catch (error) {
            if (error.code === "ENOENT")
                throw new Error(`Module not found: ${specifier}`);
            throw new Error(`Failed to inspect module "${specifier}": ${formatErrorMessage(error)}`);
        }
        if (!stats.isFile())
            throw new Error(`Unsupported import specifier "${specifier}" in node_repl. Directory imports are not supported.`);
        const extension = path.extname(resolvedPath).toLowerCase();
        if (extension !== ".js" && extension !== ".mjs") {
            throw new Error(`Unsupported import specifier "${specifier}" in node_repl. Only .js and .mjs files are supported.`);
        }
        return { kind: "file", path: resolvedPath };
    }
    resolveBareSpecifier(specifier) {
        let firstError;
        for (const base of this.moduleSearchBases) {
            try {
                const resolved = createRequire(path.join(base, "__node_repl__.cjs")).resolve(specifier, { conditions: ["node", "import"] });
                if (isWithinBaseNodeModules(base, resolved))
                    return resolved;
            }
            catch (error) {
                const code = error.code;
                if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND")
                    continue;
                firstError ??= error;
            }
        }
        if (firstError)
            throw firstError;
        return null;
    }
    cacheKey(id, kind) {
        return `${kind}:${id}`;
    }
}
function resolvedCacheId(resolved) {
    if (resolved.kind === "builtin")
        return `builtin:${resolved.specifier}`;
    if (resolved.kind === "package")
        return `package:${resolved.path}`;
    return resolved.path;
}
// Builtin import allowlist for untrusted cell code: pure computation modules
// only. This closes the direct import path to host-privileged builtins (fs,
// child_process, vm, worker_threads, http, ...) — it is one layer of defense,
// not a full sandbox boundary: host-realm globals injected into the context
// (e.g. Buffer) still expose cross-realm escapes.
// Trusted referrers (bundled browser/computer-use clients) keep full builtin
// access; their own bootstrap imports node:fs/promises.
const ALLOWED_BUILTIN_MODULES = new Set([
    "node:assert", "node:assert/strict", "node:buffer", "node:crypto",
    "node:events", "node:path", "node:path/posix", "node:path/win32",
    "node:punycode", "node:querystring", "node:string_decoder",
    "node:timers", "node:timers/promises", "node:url", "node:util",
    "node:zlib",
]);
function isTrustedReferrer(referrerIdentifier) {
    if (options.trustAllImportedCode)
        return true;
    if (typeof referrerIdentifier !== "string" || !path.isAbsolute(referrerIdentifier))
        return false;
    const candidate = canonicalPath(referrerIdentifier);
    return trustedCodePaths.some((directory) => isSameOrWithin(candidate, directory));
}
function isPathSpecifier(specifier) {
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith(".\\") || specifier.startsWith("..\\"))
        return true;
    if (path.isAbsolute(specifier))
        return true;
    if (!specifier.startsWith("file:"))
        return false;
    try {
        return new URL(specifier).protocol === "file:";
    }
    catch {
        return false;
    }
}
function isBarePackageSpecifier(specifier) {
    if (!specifier || specifier.trim() !== specifier)
        return false;
    if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") || specifier.startsWith("\\"))
        return false;
    if (path.isAbsolute(specifier) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier) || specifier.includes("\\"))
        return false;
    return true;
}
function isWithinBaseNodeModules(base, resolvedPath) {
    const root = path.resolve(canonicalPath(base), "node_modules");
    const relative = path.relative(root, canonicalPath(resolvedPath));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
const moduleLoader = new ModuleLoader();
defineLockedGlobal(untrustedContext, "setupBrowserRuntime", async () => {
    if (!browserClientPath)
        throw new Error("Lume Browser trusted client is unavailable");
    const browserClient = await moduleLoader.dynamicImport(browserClientPath, path.join(cwd, ".node_repl_browser_bootstrap.mjs"), false);
    if (typeof browserClient.setupLumeBrowserRuntime !== "function")
        throw new Error("Lume Browser trusted client is invalid");
    const runtime = await browserClient.setupLumeBrowserRuntime({ globals: untrustedContext });
    return runtime.agent;
});
async function isTrustedFile(filePath) {
    if (options.trustAllImportedCode)
        return true;
    const candidate = canonicalPath(await fs.realpath(filePath).catch(() => filePath));
    if (trustedCodePaths.some((directory) => isSameOrWithin(candidate, directory)))
        return true;
    if (trustedSourceHashes.size === 0)
        return false;
    const source = await fs.readFile(filePath);
    return trustedSourceHashes.has(crypto.createHash("sha256").update(source).digest("hex"));
}
function isSameOrWithin(candidate, directory) {
    const relative = path.relative(directory, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function canonicalPath(value) {
    let resolved = value;
    try {
        resolved = fsSync.realpathSync.native(value);
    }
    catch { /* preserve */ }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function normalizeHash(value) { return value.trim().toLowerCase().replace(/^sha256[:-]/, ""); }
async function execute(message) {
    moduleLoader.clearLocalCache();
    activeExecId = message.id;
    currentRequestMeta = message.requestMeta && typeof message.requestMeta === "object" ? deepFreeze(structuredClone(message.requestMeta)) : null;
    currentFormElicitationSupported = message.formElicitationSupported === true;
    const state = {
        id: message.id,
        outputEvents: [],
        responseMeta: null,
        pendingBackgroundTasks: new Set(),
        telemetrySpans: [],
        telemetryDroppedSpanCount: 0,
        telemetrySpanCounter: 0,
        telemetryStartedAtMs: performance.now(),
    };
    let module = null;
    let linked = false;
    let preludeCompleted = false;
    let built = null;
    const committedNames = new Set();
    try {
        built = buildCellSource(typeof message.code === "string" ? message.code : "", previousBindings, {
            salt: internalSalt,
            nextInternalId: () => internalCounter++,
        });
        parent.postMessage({ type: "redacted-source", id: message.id, source: built.redactedSource });
        await execStorage.run(state, async () => {
            const consoleObject = capturedConsole(state);
            untrustedContext.console = consoleObject;
            trustedContext.console = consoleObject;
            try {
                const identifier = path.join(cwd, `.node_repl_cell_${cellCounter++}.mjs`);
                module = new vm.SourceTextModule(built.source, {
                    context: untrustedContext,
                    identifier,
                    initializeImportMeta(meta, mod) {
                        moduleLoader.setImportMeta(meta, mod, true);
                        meta.__lumeMarkCommittedBindings = (...names) => { for (const name of names)
                            committedNames.add(name); };
                        meta.__lumeMarkPreludeCompleted = () => { preludeCompleted = true; };
                    },
                    importModuleDynamically: ((specifier, referrer) => moduleLoader.dynamicImport(specifier, referrer.identifier, false)),
                });
                await module.link(async (specifier) => {
                    if (specifier === "@prev" && previousModule) {
                        const previous = previousModule;
                        const exportNames = previousBindings.map((binding) => binding.name);
                        return new vm.SyntheticModule(exportNames, function initialize() {
                            for (const binding of previousBindings)
                                this.setExport(binding.name, previous.namespace[binding.name]);
                        }, { context: untrustedContext, identifier: `@prev:${message.id}` });
                    }
                    throw new Error(`Top-level static import "${specifier}" is not supported in node_repl. Use await import("${specifier}") instead.`);
                });
                linked = true;
                await module.evaluate();
                await drainBackgroundTasks(state);
            }
            finally {
                untrustedContext.console = console;
                trustedContext.console = console;
            }
        });
        previousModule = module;
        previousBindings = built.nextBindings;
        parent.postMessage({
            type: "execution-result",
            id: message.id,
            ok: true,
            output: renderOutput(state.outputEvents),
            error: null,
            responseMeta: state.responseMeta,
            responseMetaTrace: buildTrace(state),
        });
    }
    catch (error) {
        if (module && linked && built) {
            const committed = collectCommittedBindings(module, built.priorBindings, built.currentBindings, committedNames);
            if (committed.currentCount > 0 || (preludeCompleted && built.priorBindings.length > 0)) {
                previousModule = module;
                previousBindings = committed.bindings;
            }
        }
        parent.postMessage({
            type: "execution-result",
            id: message.id,
            ok: false,
            output: "",
            error: formatErrorMessage(error),
            responseMeta: state.responseMeta,
            responseMetaTrace: buildTrace(state),
        });
    }
    finally {
        if (activeExecId === message.id)
            activeExecId = null;
        currentRequestMeta = null;
        currentFormElicitationSupported = false;
    }
}
function collectCommittedBindings(module, prior, current, names) {
    const merged = new Map(prior.map((binding) => [binding.name, binding.kind]));
    let currentCount = 0;
    for (const binding of current) {
        let readable = false;
        if (!["var", "function"].includes(binding.kind)) {
            try {
                void module.namespace[binding.name];
                readable = true;
            }
            catch {
                readable = false;
            }
        }
        if (names.has(binding.name) || readable) {
            merged.set(binding.name, binding.kind);
            currentCount += 1;
        }
    }
    return { bindings: [...merged].map(([name, kind]) => ({ name, kind })), currentCount };
}
function createTelemetryBridge() {
    const startSpan = (nameValue, attrsValue = {}) => {
        let state;
        try {
            state = getCurrentExecState();
        }
        catch {
            return { span: Object.freeze({ end() { } }), spanId: null };
        }
        const spanId = `span-${++state.telemetrySpanCounter}`;
        const parentId = spanStorage.getStore()?.spanId;
        const started = performance.now();
        let ended = false;
        const span = Object.freeze({
            end(optionsValue = {}) {
                if (ended)
                    return;
                ended = true;
                if (state.telemetrySpans.length >= 1024) {
                    state.telemetryDroppedSpanCount += 1;
                    return;
                }
                const optionsRecord = isPlainObject(optionsValue) ? optionsValue : {};
                const attrs = sanitizeTraceAttrs({ ...(isPlainObject(attrsValue) ? attrsValue : {}), ...(isPlainObject(optionsRecord.attrs) ? optionsRecord.attrs : {}) });
                const record = {
                    id: spanId,
                    name: (() => { const name = String(nameValue); return (name || "unknown").slice(0, 128); })(),
                    start_ms: roundMs(started - state.telemetryStartedAtMs),
                    duration_ms: roundMs(performance.now() - started),
                    status: optionsRecord.status === "error" ? "error" : "ok",
                    attrs,
                };
                if (parentId)
                    record.parent_id = parentId;
                state.telemetrySpans.push(record);
            },
        });
        return { span, spanId };
    };
    return Object.freeze({
        startSpan(name, attrs) { return startSpan(name, attrs).span; },
        async withSpan(name, attrs, operation, spanOptions = {}) {
            if (typeof operation !== "function")
                return undefined;
            const { span, spanId } = startSpan(name, attrs);
            const run = async () => {
                try {
                    const result = await operation();
                    let resultAttrs;
                    if (isPlainObject(spanOptions) && typeof spanOptions.resultAttrs === "function") {
                        try {
                            resultAttrs = spanOptions.resultAttrs(result);
                        }
                        catch {
                            resultAttrs = undefined;
                        }
                    }
                    span.end({ status: "ok", attrs: resultAttrs });
                    return result;
                }
                catch (error) {
                    span.end({ status: "error", attrs: { "error.kind": error instanceof Error ? error.name : typeof error } });
                    throw error;
                }
            };
            return spanId ? spanStorage.run({ spanId }, run) : run();
        },
    });
}
function buildTrace(state) {
    if (!options.responseMetaTrace || state.telemetrySpans.length === 0)
        return null;
    const trace = { version: 1, spans: [...state.telemetrySpans].sort((a, b) => a.start_ms - b.start_ms) };
    if (state.telemetryDroppedSpanCount > 0)
        trace.dropped_span_count = state.telemetryDroppedSpanCount;
    return trace;
}
function sanitizeTraceAttrs(value) {
    const result = {};
    let count = 0;
    for (const [key, raw] of Object.entries(value)) {
        if (!key || key.length > 128)
            continue;
        let normalized;
        if (typeof raw === "boolean" || (typeof raw === "number" && Number.isFinite(raw)))
            normalized = raw;
        else if (typeof raw === "string")
            normalized = raw.slice(0, 256);
        if (normalized === undefined)
            continue;
        result[key] = normalized;
        count += 1;
        if (count >= 32)
            break;
    }
    return result;
}
function roundMs(value) { return Math.round(value * 1000) / 1000; }
function formatErrorMessage(error) {
    if (error && typeof error === "object" && "message" in error) {
        const message = error.message;
        return message ? String(message) : String(error);
    }
    return String(error);
}
function normalizeConfigEditRequest(value, operation) {
    if (!isPlainObject(value))
        throw new Error(`${operation} request must be an object`);
    if (typeof value.keyPath !== "string" || !value.keyPath.trim())
        throw new Error(`${operation} keyPath must be a non-empty string`);
    const mergeStrategy = value.mergeStrategy ?? "upsert";
    if (mergeStrategy !== "replace" && mergeStrategy !== "upsert")
        throw new Error(`${operation} mergeStrategy must be "replace" or "upsert"`);
    assertJsonCompatible(value.value, `${operation} value must be a JSON-serializable value`);
    return { key_path: value.keyPath, merge_strategy: mergeStrategy, value: structuredClone(value.value) };
}
function normalizeConfigWriteRequest(value, operation, action) {
    if (!isPlainObject(value))
        throw new Error(`${operation} request must be an object`);
    if (typeof value.keyPath !== "string" || !value.keyPath.trim())
        throw new Error(`${operation} keyPath must be a non-empty string`);
    const mergeStrategy = value.mergeStrategy ?? "upsert";
    if (mergeStrategy !== "replace" && mergeStrategy !== "upsert")
        throw new Error(`${operation} mergeStrategy must be "replace" or "upsert"`);
    assertJsonCompatible(value.value, `${operation} value must be a JSON-serializable value`);
    return {
        action,
        key_path: value.keyPath,
        merge_strategy: mergeStrategy,
        value: structuredClone(value.value),
        expected_version: normalizeExpectedVersion(value.expectedVersion, operation),
    };
}
function normalizeExpectedVersion(value, operation) {
    if (value === undefined || value === null)
        return value;
    if (typeof value !== "string")
        throw new Error(`${operation} expectedVersion must be a string or null`);
    return value;
}
function assertJsonCompatible(value, message) {
    const valid = value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (Array.isArray(value) && value.every((entry) => { try {
        assertJsonCompatible(entry, message);
        return true;
    }
    catch {
        return false;
    } })) || (isPlainObject(value) && Object.values(value).every((entry) => entry !== undefined && (() => { try {
        assertJsonCompatible(entry, message);
        return true;
    }
    catch {
        return false;
    } })()));
    if (!valid)
        throw new Error(message);
}
function normalizeNonEmptyString(value, label) {
    if (typeof value !== "string" || !value)
        throw new Error(`${label} must be a non-empty string`);
    return value;
}
function nonEmptyString(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function freezeEnv(source) { return Object.freeze({ ...source }); }
function pickEnvironment(source, names) {
    return Object.fromEntries(names.flatMap((name) => typeof source[name] === "string" ? [[name, source[name]]] : []));
}
function scheduleFatalExit(kind, error) {
    if (fatalExitScheduled)
        return;
    fatalExitScheduled = true;
    const active = activeExecId;
    if (active) {
        parent.postMessage({
            type: "execution-result",
            id: active,
            ok: false,
            output: "",
            error: `node_repl kernel ${kind}: ${formatErrorMessage(error)}; kernel reset. Catch or handle async errors (including Promise rejections and EventEmitter 'error' events) to avoid kernel termination.`,
            responseMeta: null,
            responseMetaTrace: null,
        });
    }
    parent.postMessage({ type: "fatal", error: error instanceof Error ? error.stack ?? error.message : String(error) });
    setImmediate(() => process.exit(1));
}
process.on("uncaughtException", (error) => scheduleFatalExit("uncaught exception", error));
process.on("unhandledRejection", (reason) => scheduleFatalExit("unhandled rejection", reason));
parent.on("message", (message) => {
    if (message.type === "shutdown") {
        process.exit(0);
        return;
    }
    if (message.type === "host-response") {
        const pending = pendingCalls.get(message.callId);
        if (!pending)
            return;
        pendingCalls.delete(message.callId);
        if (message.ok)
            pending.resolve(message.value);
        else
            pending.reject(new Error(message.error ?? "Host call failed"));
        return;
    }
    if (message.type === "native-event") {
        const connection = nativeConnections.get(message.connectionId);
        if (!connection) {
            if (message.event === "close" || message.event === "error") {
                pendingNativePipeClosures.set(message.connectionId, message.event === "error" ? new Error(message.error ?? "native pipe error") : null);
            }
            return;
        }
        if (message.event === "data")
            handleNativePipeData(connection, Buffer.from(message.dataBase64 ?? "", "base64"));
        else
            closeNativePipeState(connection, message.event === "error" ? new Error(message.error ?? "native pipe error") : null);
        return;
    }
    if (message.type === "add-module-dir") {
        moduleLoader.addModuleDir(message.path);
        return;
    }
    executionQueue = executionQueue.then(() => execute(message)).catch((error) => {
        parent.postMessage({ type: "worker-error", error: error instanceof Error ? error.stack ?? error.message : String(error) });
    });
});
parent.postMessage({ type: "ready" });
//# sourceMappingURL=worker.js.map
