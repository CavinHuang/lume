import test from "node:test";
import assert from "node:assert/strict";
import { buildMacSidecarCommand } from "./sidecar-runtime.mjs";

test("buildMacSidecarCommand 应为 mac bridge 生成 node bridge 命令", () => {
  const cmd = buildMacSidecarCommand({
    nodeBin: "node",
    bunBin: "/bun",
    sidecarDir: "/repo/apps/sidecar",
    entry: "src/index.ts",
    bridgePath: "/repo/apps/desktop/scripts/sidecar-node-bridge.mjs"
  });

  assert.equal(
    cmd,
    'exec "node" "/repo/apps/desktop/scripts/sidecar-node-bridge.mjs" --bun "/bun" --cwd "/repo/apps/sidecar" --entry "src/index.ts"'
  );
});

test("buildMacSidecarCommand 在 echoMode 下应直接执行 bun 脚本", () => {
  const cmd = buildMacSidecarCommand({
    bunBin: "/bun",
    entry: "/tmp/echo.js",
    sidecarDir: "/unused",
    bridgePath: "/unused",
    echoMode: true
  });

  assert.equal(cmd, 'exec "/bun" "/tmp/echo.js"');
});
