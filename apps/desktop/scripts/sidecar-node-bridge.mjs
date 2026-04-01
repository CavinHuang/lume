import { spawn } from "node:child_process";

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const bunBin = readArg("--bun");
const cwd = readArg("--cwd");
const entry = readArg("--entry");

if (!bunBin || !cwd || !entry) {
  console.error("[sidecar-bridge] missing required args");
  process.exit(1);
}

const child = spawn(bunBin, [entry], {
  cwd,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"]
});

process.stdin.on("data", (chunk) => {
  if (!child.stdin.writable) return;
  if (!child.stdin.write(chunk)) {
    process.stdin.pause();
  }
});

child.stdin.on("drain", () => {
  process.stdin.resume();
});

process.stdin.on("end", () => {
  child.stdin.end();
});

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill(sig);
  });
}
