import { fileURLToPath } from "node:url";

const smokeTests = [
  "atoms/agent-runtime-status.test.ts",
  "lib/agent-runtime-status.test.ts",
  "lib/desktop-api.agent-runtime-status.test.ts",
  "components/chat/chat-session-lifecycle.test.ts",
  "components/chat/chat-stream-subscriptions.test.ts",
  "components/chat/stream-finalizer.test.ts",
  "components/agent/agent-session-lifecycle.test.ts",
  "components/agent/agent-stream-subscriptions.test.ts",
  "components/agent/agent-interactive-requests.test.ts",
  "components/app-shell/left-sidebar-conversations.test.ts",
  "components/app-shell/left-sidebar-agent-sessions.test.ts",
];

const result = Bun.spawnSync({
  cmd: [process.execPath, "test", ...smokeTests],
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdout: "inherit",
  stderr: "inherit",
});

if (result.exitCode !== 0) {
  process.exit(result.exitCode);
}
