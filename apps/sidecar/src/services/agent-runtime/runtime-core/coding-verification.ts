import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const SCRIPT_PRIORITY = ["check", "typecheck", "test", "lint", "build"] as const;

interface PackageManifest {
  scripts?: Record<string, unknown>;
}

export interface VerificationCommandCandidate {
  command: string;
  script: string;
  packageRoot: string;
  reason: "changed_source" | "changed_tests" | "fallback";
}

/**
 * Selects existing repository scripts without inventing commands. Execution is
 * still performed by the governed Bash tool so permissions and sandbox policy
 * remain in the normal runtime path.
 */
export function selectVerificationCommands(input: {
  workspaceRoot: string;
  changedFiles: string[];
}): VerificationCommandCandidate[] {
  const workspaceRoot = resolve(input.workspaceRoot);
  const packageRoots = new Set<string>();
  const changedFiles = input.changedFiles.map((path) => resolve(workspaceRoot, path));

  for (const changedFile of changedFiles) {
    let current = existsSync(changedFile) ? dirname(changedFile) : dirname(changedFile);
    while (isWithinWorkspace(workspaceRoot, current)) {
      if (existsSync(resolve(current, "package.json"))) packageRoots.add(current);
      if (current === workspaceRoot) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  if (existsSync(resolve(workspaceRoot, "package.json"))) packageRoots.add(workspaceRoot);

  const hasTests = input.changedFiles.some((path) => /(^|[./\\])[^/\\]*(test|spec)[^/\\]*\.[^/\\]+$/i.test(path));
  const hasSource = input.changedFiles.some((path) => /\.(c|m)?(ts|tsx|js|jsx|py|go|rs|java|kt|swift|rb)$/i.test(path));
  const candidates: VerificationCommandCandidate[] = [];

  for (const packageRoot of [...packageRoots].sort((left, right) => left.length - right.length)) {
    const manifest = readManifest(resolve(packageRoot, "package.json"));
    if (!manifest?.scripts) continue;
    for (const script of SCRIPT_PRIORITY) {
      if (typeof manifest.scripts[script] !== "string") continue;
      if (script === "test" && !hasTests && hasSource) continue;
      const packagePath = relative(workspaceRoot, packageRoot).replace(/\\/g, "/");
      const command = packagePath
        ? `bun run --cwd ${quoteShellWord(packagePath)} ${script}`
        : `bun run ${script}`;
      candidates.push({
        command,
        script,
        packageRoot,
        reason: script === "test" && hasTests ? "changed_tests" : hasSource ? "changed_source" : "fallback"
      });
    }
  }

  const selected: VerificationCommandCandidate[] = [];
  for (const candidate of candidates) {
    if (selected.some((item) => item.command === candidate.command)) continue;
    selected.push(candidate);
    if (selected.length >= 2) break;
  }
  return selected;
}

function isWithinWorkspace(workspaceRoot: string, candidate: string): boolean {
  const path = relative(workspaceRoot, candidate);
  return path === "" || (!path.startsWith(".." + "/") && !path.startsWith(".." + "\\") && path !== "..");
}

function readManifest(path: string): PackageManifest | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function quoteShellWord(value: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
