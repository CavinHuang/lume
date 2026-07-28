import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const repositoryRoot = join(packageRoot, "..", "..");
const sourceRoot = join(packageRoot, "src");
const batchSize = 40;

function collectTests(directory) {
  const tests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...collectTests(path));
    } else if (entry.name.endsWith(".test.ts")) {
      tests.push(path);
    }
  }
  return tests;
}

function run(files) {
  const result = Bun.spawnSync({
    cmd: ["bun", "test", ...files],
    cwd: repositoryRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

const tests = collectTests(sourceRoot)
  .map((path) => relative(repositoryRoot, path))
  .sort();
const isolated = [];
const ordinary = [];

for (const path of tests) {
  const source = readFileSync(join(repositoryRoot, path), "utf8");
  const needsIsolatedProcess = path.endsWith(".integration.test.ts")
    || source.includes("mock.module(")
    || source.includes("setLogBatchNotificationWriter(");
  (needsIsolatedProcess ? isolated : ordinary).push(path);
}

for (let index = 0; index < ordinary.length; index += batchSize) {
  run(ordinary.slice(index, index + batchSize));
}
for (const path of isolated) run([path]);
