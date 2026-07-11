import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipNative = process.argv.includes("--skip-native");
const bun = process.execPath;

const checks = [
  [bun, ["test", "packages/shared/src/types/computer-use.test.ts"]],
  [bun, ["test", "apps/desktop/scripts/electron-security.test.mjs"]],
  [bun, ["test", "apps/desktop/scripts/desktop-package.test.mjs"]],
  [bun, ["test", "apps/web/src/components/agent/agent-input-desktop-context.test.ts"]],
  [bun, ["test", "apps/web/src/components/agent/AgentInput.desktop-context.test.tsx"]],
  [bun, ["test", "apps/web/src/components/quick-input/QuickInput.test.tsx"]],
  [bun, ["test", "apps/web/src/components/welcome/WelcomeView.test.tsx"]],
  [bun, ["test", "apps/web/src/components/agent/DesktopActionBanner.test.tsx"]],
  [bun, ["test", "apps/web/src/components/agent/DesktopActionVisualOverlay.test.tsx"]],
  [bun, ["test", "apps/sidecar/src/services/desktop-context/desktop-context-service.test.ts"]],
  [bun, ["test", "apps/sidecar/src/services/desktop-context/desktop-context-runtime.test.ts"]],
  [bun, ["test", "apps/sidecar/src/services/agent-runtime/tools/computer-use/create-computer-use-tools.test.ts"]],
  [bun, ["test", "apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts"]],
  [bun, ["run", "--filter", "@lume/shared", "typecheck"]],
  [bun, ["run", "--filter", "@lume/sidecar", "typecheck"]],
  [bun, ["run", "--filter", "@lume/web", "typecheck"]],
];

if (!skipNative) {
  checks.push([
    "cargo",
    ["test", "--locked", "--manifest-path", "crates/lume-desktop-host/Cargo.toml"],
  ]);
}

for (const [command, args] of checks) {
  console.error(`[computer-use] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.error(`[computer-use] verification passed${skipNative ? " (native host skipped)" : ""}`);
