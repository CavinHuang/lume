import { isPathInside } from "./path-containment";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SCRIPT_PRIORITY = ["check", "typecheck", "test", "lint", "build"] as const;

interface PackageManifest {
  scripts?: Record<string, unknown>;
}

export interface VerificationCommandCandidate {
  command: string;
  script: string;
  packageRoot: string;
  rootId?: string;
  reason: "changed_source" | "changed_tests" | "fallback";
}

export interface VerificationWorkspaceInput {
  workspaceRoot: string;
  changedFiles: string[];
  rootId?: string;
}

/**
 * Selects existing repository scripts without inventing commands. Execution is
 * still performed by the governed Bash tool so permissions and sandbox policy
 * remain in the normal runtime path.
 */
export function selectVerificationCommands(input: {
  workspaceRoot: string;
  changedFiles: string[];
  explicitCwd?: boolean;
}): VerificationCommandCandidate[] {
  const workspaceRoot = resolve(input.workspaceRoot);
  const packageRoots = new Set<string>();
  const changedFiles = input.changedFiles.map((path) => resolve(workspaceRoot, path));

  for (const changedFile of changedFiles) {
    let current = existsSync(changedFile) ? dirname(changedFile) : dirname(changedFile);
    while (isPathInside(workspaceRoot, current)) {
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
    const packageManager = detectPackageManager(packageRoot, manifest);
    for (const script of SCRIPT_PRIORITY) {
      if (typeof manifest.scripts[script] !== "string") continue;
      if (script === "test" && !hasTests && hasSource) continue;
      const packagePath = relative(workspaceRoot, packageRoot).replace(/\\/g, "/");
      const commandRoot = input.explicitCwd ? packageRoot : packagePath;
      const command = createPackageScriptCommand(packageManager, commandRoot, script);
      candidates.push({
        command,
        script,
        packageRoot,
        reason: script === "test" && hasTests ? "changed_tests" : hasSource ? "changed_source" : "fallback"
      });
    }
  }
  candidates.push(...selectLanguageVerificationCommands({
    workspaceRoot,
    changedFiles,
    hasTests,
  }));

  const selected: VerificationCommandCandidate[] = [];
  for (const candidate of candidates) {
    if (selected.some((item) => item.command === candidate.command)) continue;
    selected.push(candidate);
    if (selected.length >= 2) break;
  }
  return selected;
}

/**
 * Selects commands independently for every changed workspace root. One command
 * from each root is returned before optional second choices, so an additional
 * repository cannot be hidden by the primary repository's script priority.
 */
export function selectVerificationCommandsForWorkspaces(
  workspaces: VerificationWorkspaceInput[]
): VerificationCommandCandidate[] {
  const byWorkspace = workspaces
    .filter((workspace) => workspace.changedFiles.length > 0)
    .map((workspace) => selectVerificationCommands({
      workspaceRoot: workspace.workspaceRoot,
      changedFiles: workspace.changedFiles,
      explicitCwd: true,
    }).map((candidate) => ({
      ...candidate,
      ...(workspace.rootId ? { rootId: workspace.rootId } : {}),
    })));
  const selected: VerificationCommandCandidate[] = [];
  for (let index = 0; index < 2; index += 1) {
    for (const candidates of byWorkspace) {
      const candidate = candidates[index];
      if (candidate && !selected.some((item) => item.command === candidate.command)) selected.push(candidate);
    }
  }
  return selected;
}

function readManifest(path: string): PackageManifest & { packageManager?: string } | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as PackageManifest & { packageManager?: string };
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function detectPackageManager(packageRoot: string, manifest: PackageManifest & { packageManager?: string }): "bun" | "pnpm" | "yarn" | "npm" {
  const configured = manifest.packageManager?.split("@")[0]?.toLowerCase();
  if (configured === "pnpm" || configured === "yarn" || configured === "npm" || configured === "bun") return configured;
  if (existsSync(join(packageRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(packageRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(packageRoot, "package-lock.json"))) return "npm";
  return "bun";
}

function createPackageScriptCommand(
  manager: "bun" | "pnpm" | "yarn" | "npm",
  cwd: string,
  script: string
): string {
  const cwdArg = cwd ? quoteShellWord(cwd) : "";
  if (manager === "pnpm") return cwdArg ? `pnpm --dir ${cwdArg} run ${script}` : `pnpm run ${script}`;
  if (manager === "yarn") return cwdArg ? `yarn --cwd ${cwdArg} ${script}` : `yarn ${script}`;
  if (manager === "npm") return cwdArg ? `npm --prefix ${cwdArg} run ${script}` : `npm run ${script}`;
  return cwdArg ? `bun run --cwd ${cwdArg} ${script}` : `bun run ${script}`;
}

function selectLanguageVerificationCommands(input: {
  workspaceRoot: string;
  changedFiles: string[];
  hasTests: boolean;
}): VerificationCommandCandidate[] {
  const candidates: VerificationCommandCandidate[] = [];
  const changedExtensions = new Set(input.changedFiles.map((path) => path.slice(path.lastIndexOf(".")).toLowerCase()));

  if (changedExtensions.has(".py")) {
    for (const root of findProjectRoots(input.workspaceRoot, input.changedFiles, ["pyproject.toml", "pytest.ini", "tox.ini", "mypy.ini"])) {
      const pyproject = readOptionalText(join(root, "pyproject.toml"));
      if (pyproject.includes("[tool.pyright]")) {
        candidates.push(commandCandidate(`pyright ${quoteShellWord(root)}`, "pyright", root, input.hasTests));
      } else if (pyproject.includes("[tool.mypy]") || existsSync(join(root, "mypy.ini"))) {
        candidates.push(commandCandidate(`python -m mypy ${quoteShellWord(root)}`, "mypy", root, input.hasTests));
      }
      if (input.hasTests || existsSync(join(root, "pytest.ini")) || pyproject.includes("[tool.pytest")) {
        candidates.push(commandCandidate(`python -m pytest ${quoteShellWord(root)}`, "pytest", root, input.hasTests));
      }
    }
  }

  if (changedExtensions.has(".go")) {
    for (const root of findProjectRoots(input.workspaceRoot, input.changedFiles, ["go.mod"])) {
      candidates.push(commandCandidate(`go -C ${quoteShellWord(root)} test ./...`, "go:test", root, input.hasTests));
    }
  }

  if (changedExtensions.has(".rs")) {
    for (const root of findProjectRoots(input.workspaceRoot, input.changedFiles, ["Cargo.toml"])) {
      const manifest = quoteShellWord(join(root, "Cargo.toml"));
      candidates.push(commandCandidate(`cargo check --manifest-path ${manifest}`, "cargo:check", root, input.hasTests));
      if (input.hasTests) candidates.push(commandCandidate(`cargo test --manifest-path ${manifest}`, "cargo:test", root, true));
    }
  }

  if ([...changedExtensions].some((extension) => extension === ".java" || extension === ".kt")) {
    for (const root of findProjectRoots(input.workspaceRoot, input.changedFiles, ["gradlew", "gradlew.bat", "pom.xml", "mvnw", "mvnw.cmd", "build.gradle", "build.gradle.kts"])) {
      const command = createJavaVerificationCommand(root);
      if (command) candidates.push(commandCandidate(command, "java:test", root, input.hasTests));
    }
  }

  if ([...changedExtensions].some((extension) => extension === ".cs" || extension === ".fs" || extension === ".vb")) {
    for (const root of findDotnetProjectRoots(input.workspaceRoot, input.changedFiles)) {
      const project = findDotnetProject(root);
      if (project) candidates.push(commandCandidate(`dotnet test ${quoteShellWord(project)}`, "dotnet:test", root, input.hasTests));
    }
  }

  return candidates;
}

function commandCandidate(
  command: string,
  script: string,
  packageRoot: string,
  hasTests: boolean
): VerificationCommandCandidate {
  return {
    command,
    script,
    packageRoot,
    reason: hasTests ? "changed_tests" : "changed_source",
  };
}

function findProjectRoots(workspaceRoot: string, changedFiles: string[], markers: string[]): string[] {
  const roots = new Set<string>();
  for (const changedFile of changedFiles) {
    let current = dirname(resolve(workspaceRoot, changedFile));
    while (isPathInside(workspaceRoot, current)) {
      if (markers.some((marker) => existsSync(join(current, marker)))) {
        roots.add(current);
        break;
      }
      if (current === workspaceRoot) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  if (markers.some((marker) => existsSync(join(workspaceRoot, marker)))) roots.add(workspaceRoot);
  return [...roots].sort((left, right) => left.length - right.length);
}

function findDotnetProjectRoots(workspaceRoot: string, changedFiles: string[]): string[] {
  const roots = new Set<string>();
  for (const changedFile of changedFiles) {
    let current = dirname(resolve(workspaceRoot, changedFile));
    while (isPathInside(workspaceRoot, current)) {
      if (findDotnetProject(current)) {
        roots.add(current);
        break;
      }
      if (current === workspaceRoot) break;
      current = dirname(current);
    }
  }
  return [...roots];
}

function findDotnetProject(root: string): string | undefined {
  try {
    return readdirSync(root)
      .filter((entry) => /\.(sln|csproj|fsproj|vbproj)$/i.test(entry))
      .sort((left, right) => left.localeCompare(right))
      .map((entry) => join(root, entry))[0];
  } catch {
    return undefined;
  }
}

function createJavaVerificationCommand(root: string): string | undefined {
  const gradleWrapper = process.platform === "win32"
    ? ["gradlew.bat", "gradlew"].find((name) => existsSync(join(root, name)))
    : ["gradlew", "gradlew.bat"].find((name) => existsSync(join(root, name)));
  if (gradleWrapper) {
    const executable = quoteShellWord(join(root, gradleWrapper));
    return `${process.platform === "win32" ? "& " : ""}${executable} -p ${quoteShellWord(root)} test`;
  }
  const mavenWrapper = process.platform === "win32"
    ? ["mvnw.cmd", "mvnw"].find((name) => existsSync(join(root, name)))
    : ["mvnw", "mvnw.cmd"].find((name) => existsSync(join(root, name)));
  if (mavenWrapper) {
    const executable = quoteShellWord(join(root, mavenWrapper));
    return `${process.platform === "win32" ? "& " : ""}${executable} -f ${quoteShellWord(join(root, "pom.xml"))} test`;
  }
  if (existsSync(join(root, "pom.xml"))) return `mvn -f ${quoteShellWord(join(root, "pom.xml"))} test`;
  if (existsSync(join(root, "build.gradle")) || existsSync(join(root, "build.gradle.kts"))) {
    return `gradle -p ${quoteShellWord(root)} test`;
  }
  return undefined;
}

function readOptionalText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function quoteShellWord(value: string): string {
  return /^[a-zA-Z0-9_./:\\-]+$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}
