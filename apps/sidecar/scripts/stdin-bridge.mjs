import { spawn } from "node:child_process";
import process, { env, exit, stderr, stdin, stdout } from "node:process";

const bunBin = env.LUME_BUN_BIN || "bun";

const child = spawn(bunBin, ["src/index.ts"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"]
});

stdin.pipe(child.stdin);
child.stdout.pipe(stdout);
child.stderr.pipe(stderr);

child.on("error", (error) => {
  stderr.write(`[sidecar-bridge] spawn failed: ${String(error)}\n`);
  exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    stderr.write(`[sidecar-bridge] child exited by signal: ${signal}\n`);
    exit(1);
    return;
  }
  exit(code ?? 0);
});
