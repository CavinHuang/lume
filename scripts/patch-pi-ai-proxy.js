#!/usr/bin/env node
/**
 * Patch @mariozechner/pi-ai http-proxy.js for Bun compatibility.
 *
 * Bun's built-in undici does not export EnvHttpProxyAgent (Bun handles
 * HTTP_PROXY natively). The upstream code checks process.versions.node
 * which is truthy in Bun, causing a crash. This patch adds a Bun guard.
 */
const { readFileSync, writeFileSync, existsSync } = require("fs");
const { join } = require("path");

const target = join(
  __dirname,
  "..",
  "node_modules",
  "@mariozechner",
  "pi-ai",
  "dist",
  "utils",
  "http-proxy.js"
);

if (!existsSync(target)) {
  console.log("[patch] pi-ai http-proxy.js not found, skipping");
  process.exit(0);
}

let content = readFileSync(target, "utf-8");

if (content.includes("process.versions?.bun")) {
  console.log("[patch] pi-ai http-proxy.js already patched");
  process.exit(0);
}

content = content.replace(
  'if (typeof process !== "undefined" && process.versions?.node) {',
  'if (typeof process !== "undefined" && process.versions?.node && !process.versions?.bun) {'
);

content = content.replace(
  "setGlobalDispatcher(new EnvHttpProxyAgent());",
  'if (typeof EnvHttpProxyAgent === "function") {\n            setGlobalDispatcher(new EnvHttpProxyAgent());\n        }'
);

writeFileSync(target, content, "utf-8");
console.log("[patch] pi-ai http-proxy.js patched for Bun compatibility");
