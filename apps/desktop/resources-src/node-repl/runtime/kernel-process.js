#!/usr/bin/env node
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { Worker } from "node:worker_threads";
const bootstrap = (() => {
    try {
        return parseBootstrap(process.argv.slice(2));
    }
    catch (error) {
        console.error(`node_repl invalid kernel bootstrap args: ${errorMessage(error)}`);
        process.exit(1);
    }
})();
const config = parseKernelConfig(process.env.LUME_CUA_KERNEL_CONFIG);
const bridgeToken = crypto.randomUUID();
const moduleDirs = splitPathList(process.env.NODE_REPL_NODE_MODULE_DIRS);
// #634：trusted 集若覆盖工作目录，cell 的虚拟 referrer（cwd 下
// .node_repl_cell_*.mjs）将整体落入 trusted 判定，使 builtin 白名单与
// file 模块信任分流失效——剔除覆盖 cwd 的条目并告警。
// 比较前归一尾部 separator（根条目如 "/"、"C:\" 经 resolve 后仍带尾分隔符，
// 否则 startsWith 双分隔符恒假漏判）；Windows 路径大小写不敏感。
const trustedCodePaths = splitPathList(process.env.NODE_REPL_TRUSTED_CODE_PATHS).flatMap((entry) => {
    const trimmed = entry.endsWith(path.sep) ? entry.slice(0, -1) : entry;
    const lowerCase = process.platform === "win32";
    const cwdCandidate = lowerCase ? bootstrap.workingDir.toLowerCase() : bootstrap.workingDir;
    const entryCandidate = lowerCase ? trimmed.toLowerCase() : trimmed;
    const coversCwd = cwdCandidate === entryCandidate || cwdCandidate.startsWith(entryCandidate + path.sep);
    if (coversCwd)
        console.error(`node_repl: dropping NODE_REPL_TRUSTED_CODE_PATHS entry "${entry}" because it covers the working directory`);
    return coversCwd ? [] : [entry];
});
const trustedSourceHashes = parseHashes(process.env.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S);
const untrustedEnvAllowlist = splitCommaList(process.env.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST);
const env = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[0] !== "LUME_CUA_KERNEL_CONFIG" && typeof entry[1] === "string"));
config.manifest.allowedEnv = untrustedEnvAllowlist;
try {
    process.chdir(bootstrap.workingDir);
}
catch (error) {
    console.error(`node_repl failed to switch to working directory "${bootstrap.workingDir}": ${errorMessage(error)}`);
    process.exit(1);
}
const worker = new Worker(new URL("./worker.js", import.meta.url), {
    execArgv: [...new Set([...process.execArgv, "--experimental-vm-modules"])],
    workerData: {
        cwd: bootstrap.workingDir,
        manifest: config.manifest,
        env,
        moduleDirs,
        trustedCodePaths,
        trustedSourceHashes,
        trustAllImportedCode: process.env.NODE_REPL_TRUST_ALL_CODE === "1",
        responseMetaTrace: bootstrap.responseMetaTrace,
        exposePrivilegedToRoot: config.exposePrivilegedToRoot,
        sessionId: bootstrap.sessionId,
        bridgeToken,
    },
});
const responseRoutes = new Map();
let closing = false;
worker.on("message", (message) => {
    switch (message.type) {
        case "ready":
            send({ type: "privileged_bridge_handshake", token: bridgeToken });
            return;
        case "redacted-source":
            send({ type: "exec_redacted_source", id: message.id, source: message.source });
            return;
        case "response-meta":
            send({ type: "response_meta", id: message.id, response_meta: message.responseMeta });
            return;
        case "execution-result":
            send({
                type: "exec_result",
                id: message.id,
                ok: message.ok,
                output: message.output,
                error: message.error ?? null,
                response_meta_trace: message.responseMetaTrace ?? null,
            });
            return;
        case "host-event":
            handleWorkerHostEvent(message);
            return;
        case "host-call":
            handleWorkerHostCall(message);
            return;
        case "worker-error":
            console.error(message.error);
            return;
        case "fatal":
            console.error(message.error);
            return;
    }
});
worker.once("error", (error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
});
worker.once("exit", (code) => {
    if (!closing && code !== 0)
        process.exitCode = code || 1;
    process.exit(process.exitCode ?? 0);
});
function handleWorkerHostEvent(message) {
    if (message.bridgeToken !== bridgeToken)
        return fatalProtocol(`invalid privileged bridge token for ${message.method}`);
    if (message.method === "timeout.suspend") {
        send({ type: "suspend_timeout", exec_id: message.execId, token: bridgeToken });
        return;
    }
    if (message.method === "timeout.resume") {
        send({ type: "resume_timeout", exec_id: message.execId, token: bridgeToken });
        return;
    }
    send({ type: "lume_host_event", exec_id: message.execId, token: bridgeToken, method: message.method, args: message.args });
}
function handleWorkerHostCall(message) {
    const args = asRecord(message.args);
    const privileged = message.method !== "emitImage";
    if (privileged && message.bridgeToken !== bridgeToken)
        return fatalProtocol(`invalid privileged bridge token for ${message.method}`);
    switch (message.method) {
        case "emitImage": {
            const id = asString(args.id, "id");
            responseRoutes.set(id, { callId: message.callId, kind: "emit_image_result" });
            send({ type: "emit_image", id, exec_id: asString(args.execId, "execId"), image_url: asString(args.imageUrl, "imageUrl") });
            return;
        }
        case "elicitation": {
            const id = asString(args.id, "id");
            responseRoutes.set(id, { callId: message.callId, kind: "elicitation_result" });
            send({
                type: "elicit",
                id,
                exec_id: asString(args.exec_id, "exec_id"),
                token: bridgeToken,
                message: args.message,
                requested_schema: args.requested_schema,
                meta: args.meta,
            });
            return;
        }
        case "authenticatedFetch": {
            const id = asString(args.id, "id");
            responseRoutes.set(id, { callId: message.callId, kind: "authenticated_fetch_result" });
            send({ type: "authenticated_fetch", id, exec_id: asString(args.exec_id, "exec_id"), token: bridgeToken, request: args.request });
            return;
        }
        case "config.action":
        case "launchServices.openApplication": {
            const id = asString(args.id, "id");
            responseRoutes.set(id, { callId: message.callId, kind: "privileged_result" });
            send({ ...args, token: bridgeToken });
            return;
        }
        case "nativePipe.request": {
            const id = asString(args.id, "id");
            responseRoutes.set(id, { callId: message.callId, kind: "native_pipe_response" });
            send({
                type: "native_pipe_request",
                id,
                token: bridgeToken,
                op: args.op,
                ...(args.path !== undefined ? { path: args.path } : {}),
                ...(args.connection_id !== undefined ? { connection_id: args.connection_id } : {}),
                ...(args.data_base64 !== undefined ? { data_base64: args.data_base64 } : {}),
            });
            return;
        }
        default: {
            const id = `${message.execId}-lume-host-${crypto.randomUUID()}`;
            responseRoutes.set(id, { callId: message.callId, kind: "lume_host_result" });
            send({ type: "lume_host_call", id, exec_id: message.execId, token: bridgeToken, method: message.method, args: message.args });
        }
    }
}
let pendingInputSegments = [];
process.stdin.on("data", (chunk) => {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let segmentStart = 0;
    let frameEnd = input.indexOf(0x0a);
    while (frameEnd !== -1) {
        pendingInputSegments.push(input.subarray(segmentStart, frameEnd));
        const frame = pendingInputSegments.length === 1 ? pendingInputSegments[0] : Buffer.concat(pendingInputSegments);
        pendingInputSegments = [];
        handleFrame(frame[frame.length - 1] === 0x0d ? frame.subarray(0, -1) : frame);
        segmentStart = frameEnd + 1;
        frameEnd = input.indexOf(0x0a, segmentStart);
    }
    if (segmentStart < input.length)
        pendingInputSegments.push(input.subarray(segmentStart));
});
process.stdin.on("end", () => shutdown());
process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
function handleFrame(frame) {
    if (frame.length === 0)
        return;
    let message;
    try {
        message = JSON.parse(frame.toString("utf8"));
    }
    catch {
        return;
    }
    handleInput(message);
}
function handleInput(message) {
    switch (message.type) {
        case "exec":
            worker.postMessage({
                type: "execute",
                id: asString(message.id, "id"),
                code: typeof message.code === "string" ? message.code : "",
                requestMeta: message.request_meta ?? null,
                formElicitationSupported: message.form_elicitation_supported === true,
            });
            return;
        case "add_node_module_dir":
            if (typeof message.path === "string")
                worker.postMessage({ type: "add-module-dir", path: message.path });
            return;
        case "native_pipe_data":
            worker.postMessage({ type: "native-event", connectionId: message.connection_id, event: "data", dataBase64: message.data_base64 });
            return;
        case "native_pipe_closed":
            worker.postMessage({ type: "native-event", connectionId: message.connection_id, event: message.error ? "error" : "close", error: message.error });
            return;
        case "emit_image_result":
        case "elicitation_result":
        case "authenticated_fetch_result":
        case "privileged_result":
        case "native_pipe_response":
        case "lume_host_result":
            routeResponse(message);
            return;
        case "shutdown":
            shutdown();
            return;
        default:
            return;
    }
}
function routeResponse(message) {
    const id = typeof message.id === "string" ? message.id : "";
    const route = responseRoutes.get(id);
    if (!route)
        return;
    responseRoutes.delete(id);
    if (message.type === "elicitation_result" && message.ok === true) {
        worker.postMessage({ type: "host-response", callId: route.callId, ok: true, value: { action: message.action, content: message.content, _meta: message._meta } });
        return;
    }
    if (message.type === "authenticated_fetch_result" && message.ok === true) {
        worker.postMessage({ type: "host-response", callId: route.callId, ok: true, value: message.response });
        return;
    }
    if (message.type === "native_pipe_response" && message.ok === true) {
        worker.postMessage({ type: "host-response", callId: route.callId, ok: true, value: message.result ?? {} });
        return;
    }
    if (message.type === "privileged_result" && message.ok === true) {
        worker.postMessage({ type: "host-response", callId: route.callId, ok: true, value: message.value ?? {} });
        return;
    }
    if (message.type === "lume_host_result" && message.ok === true) {
        worker.postMessage({ type: "host-response", callId: route.callId, ok: true, value: message.value });
        return;
    }
    worker.postMessage({
        type: "host-response",
        callId: route.callId,
        ok: message.ok === true,
        value: message.value ?? {},
        error: typeof message.error === "string" ? message.error : undefined,
    });
}
function shutdown() {
    if (closing)
        return;
    closing = true;
    worker.postMessage({ type: "shutdown" });
    const timer = setTimeout(() => void worker.terminate(), 750);
    timer.unref?.();
}
function send(message) {
    // #796：全帧附 bridge token。cell 可经宿主 console 直通 stdout 写任意行，
    // 无 token 的协议帧（exec_result 等）会被宿主照单解析、执行结果可被伪造；
    // 宿主侧对握手后的所有帧校验 token。与特权帧既有 token 字段同值，幂等。
    process.stdout.write(`${JSON.stringify({ ...message, token: bridgeToken })}\n`);
}
function fatalProtocol(message) {
    console.error(message);
    process.exitCode = 1;
    shutdown();
}
function parseBootstrap(argv) {
    let sessionId = null;
    let workingDir = null;
    let responseMetaTrace = false;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--session-id")
            sessionId = argv[++index] ?? null;
        else if (arg === "--working-dir")
            workingDir = argv[++index] ?? null;
        else if (arg === "--response-meta-trace")
            responseMetaTrace = true;
        else
            throw new Error(`unknown option: ${arg}`);
    }
    if (!sessionId?.trim())
        throw new Error("missing --session-id");
    if (!workingDir?.trim())
        throw new Error("missing --working-dir");
    return { sessionId, workingDir: path.resolve(workingDir), responseMetaTrace };
}
function parseKernelConfig(raw) {
    if (!raw)
        return { manifest: { name: "node-repl-process" }, exposePrivilegedToRoot: false };
    const parsed = JSON.parse(raw);
    return {
        manifest: parsed.manifest && typeof parsed.manifest === "object" ? parsed.manifest : { name: "node-repl-process" },
        exposePrivilegedToRoot: parsed.exposePrivilegedToRoot === true,
    };
}
function splitPathList(value) {
    return [...new Set((value ?? "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean).map((entry) => path.resolve(entry)))];
}
function splitCommaList(value) {
    return [...new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean))];
}
function parseHashes(value) {
    return Array.from((value ?? "").matchAll(/\b[a-fA-F0-9]{64}\b/g), (match) => match[0].toLowerCase());
}
function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("expected object");
    return value;
}
function asString(value, name) {
    if (typeof value !== "string")
        throw new Error(`${name} must be a string`);
    return value;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=kernel-process.js.map