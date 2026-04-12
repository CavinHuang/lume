const smokeCommands = [
  ["run", "--filter", "@lume/web", "test:smoke"],
  ["run", "--filter", "@lume/sidecar", "smoke:restart-restore"]
];

for (const args of smokeCommands) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit"
  });

  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}
