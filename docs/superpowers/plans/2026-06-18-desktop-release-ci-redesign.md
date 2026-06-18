# Desktop Release CI Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the desktop release pipeline so macOS ARM, macOS Intel, and Windows x64 releases ship a self-contained standalone sidecar and auto-publish only after local and remote release gates pass.

**Architecture:** Release packaging moves back to `bun --compile` sidecar binaries packaged through Tauri `externalBin`; the Rust desktop shell launches that compiled binary in release mode and keeps the local Bun path for development. GitHub Actions becomes a gated release pipeline: one job creates/reuses a single draft release, three platform jobs build/smoke/upload to that release id, one job verifies remote assets, and one job publishes the draft.

**Tech Stack:** Bun 1.3.13 scripts, Node-compatible `.mjs` verification utilities, Rust/Tauri v2 desktop shell, GitHub Actions, `gh` CLI, `tauri-apps/tauri-action@v0`.

**Spec:** `docs/superpowers/specs/2026-06-18-desktop-release-ci-redesign.md`

---

## Chunk 1: Release Contract, Runtime, and Verification Scripts

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/desktop/src-tauri/tauri.conf.json` | Base Tauri release packaging contract (`externalBin`, release resources) | Modify |
| `apps/desktop/src-tauri/tauri.release.conf.json` | Release-only Tauri overlay (`createUpdaterArtifacts`) | Keep minimal; verify unchanged intent |
| `apps/desktop/src-tauri/src/main.rs` | Release/runtime sidecar process selection and launch | Modify |
| `scripts/build-sidecar-binary.mjs` | Compile platform-specific standalone sidecar binary | Replace JS bundle packaging path |
| `scripts/verify-desktop-package-inputs.mjs` | Validate pre-Tauri package inputs and config contract | Create |
| `scripts/smoke-compiled-sidecar.mjs` | Run compiled sidecar and call `healthcheck` | Create |
| `scripts/verify-desktop-package-artifacts.mjs` | Validate local Tauri bundle outputs | Create |
| `scripts/verify-release-assets.mjs` | Validate remote GitHub Release assets and updater coverage | Create |
| `.github/workflows/release-desktop.yml` | Single-draft, gated release pipeline | Rewrite |
| `docs/release/desktop-release.md` | Public release contract docs | Update |

## Task 1: Restore Tauri Release Packaging Contract

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Inspect: `apps/desktop/src-tauri/tauri.release.conf.json`

- [ ] **Step 1: Update `tauri.conf.json` bundle contract**

Change:

```json
"externalBin": [],
"resources": [
  "resources/default-skills.tar",
  "binaries/lume-natives.node",
  "binaries/lume-sidecar.js",
  "binaries/sidecar-node-modules.zip",
  "binaries/sidecar-node-bridge.mjs"
]
```

To:

```json
"externalBin": [
  "binaries/lume-sidecar"
],
"resources": [
  "resources/default-skills.tar",
  "binaries/lume-natives.node"
]
```

- [ ] **Step 2: Confirm release overlay stays release-only**

Run: `rtk sed -n '1,80p' apps/desktop/src-tauri/tauri.release.conf.json`

Expected: It only contains release overlay settings such as:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

Do not move `externalBin` into `tauri.release.conf.json`.

- [ ] **Step 3: Verify config contract manually**

Run:

```bash
rtk node -e 'const c=require("./apps/desktop/src-tauri/tauri.conf.json"); const r=c.bundle.resources; if (JSON.stringify(c.bundle.externalBin)!=="[\"binaries/lume-sidecar\"]") process.exit(1); for (const required of ["resources/default-skills.tar","binaries/lume-natives.node"]) if (!r.includes(required)) process.exit(2); if (r.some((x)=>x.includes("lume-sidecar.js")||x.includes("sidecar-node-bridge")||x.includes("node-modules"))) process.exit(3); console.log("config ok")'
```

Expected: `config ok`

- [ ] **Step 4: Commit packaging contract**

```bash
git add apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/tauri.release.conf.json
git commit -m "🔧 chore(desktop): 恢复 release externalBin 打包合同" \
  -m "Release 产物重新以 Tauri externalBin 打包 standalone sidecar，JS bundle bridge 不再作为发布必需资源。" \
  -m "Constraint: release overlay 只保留 updater artifacts 配置" \
  -m "Not-tested: 配置合同静态校验"
```

## Task 2: Compile Platform-Specific Standalone Sidecar

**Files:**
- Modify: `scripts/build-sidecar-binary.mjs`

- [ ] **Step 1: Replace JS bundle implementation with compile target map**

Use this structure:

```js
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_ENTRY = resolve(REPO_ROOT, "apps", "sidecar", "src", "index.ts");
const OUT_BASE = resolve(REPO_ROOT, "apps", "desktop", "src-tauri", "binaries", "lume-sidecar");

const TARGETS = {
  "aarch64-apple-darwin": { bunTarget: "bun-darwin-arm64", suffix: "aarch64-apple-darwin", executable: true },
  "x86_64-apple-darwin": { bunTarget: "bun-darwin-x64", suffix: "x86_64-apple-darwin", executable: true },
  "x86_64-pc-windows-msvc": { bunTarget: "bun-windows-x64", suffix: "x86_64-pc-windows-msvc.exe", windows: true },
};

function parseTargetTriple() {
  const explicitIndex = process.argv.indexOf("--tauri-target");
  if (explicitIndex >= 0 && process.argv[explicitIndex + 1]) return process.argv[explicitIndex + 1];
  if (process.env.TAURI_TARGET_TRIPLE) return process.env.TAURI_TARGET_TRIPLE;
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin") return "x86_64-apple-darwin";
  if (process.platform === "win32") return "x86_64-pc-windows-msvc";
  return "aarch64-apple-darwin";
}

const targetTriple = parseTargetTriple();
const target = TARGETS[targetTriple];
if (!target) {
  console.error(`[sidecar-binary] unsupported Tauri target: ${targetTriple}`);
  process.exit(1);
}

const outfile = `${OUT_BASE}-${target.suffix}`;
mkdirSync(dirname(outfile), { recursive: true });

const args = [
  "build",
  SIDECAR_ENTRY,
  "--compile",
  `--target=${target.bunTarget}`,
  `--outfile=${outfile}`,
];

if (target.windows) {
  args.push("--windows-hide-console");
  args.push("--windows-title=Lume Sidecar");
}

console.error(`[sidecar-binary] bun ${args.join(" ")}`);
const result = spawnSync("bun", args, { cwd: REPO_ROOT, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(outfile)) {
  console.error(`[sidecar-binary] expected output not created: ${outfile}`);
  process.exit(1);
}
if (target.executable) chmodSync(outfile, 0o755);
console.error(`[sidecar-binary] wrote ${outfile}`);
```

- [ ] **Step 2: Remove release JS bundle packaging responsibilities**

Delete from this script:

- `lume-sidecar.js` output.
- `sidecar-node-modules.zip` creation.
- `sidecar-node-bridge.mjs` copy.
- `fflate` import and zip helpers.
- `css-tree`/`source-map-js`/`mdn-data` staging logic.

- [ ] **Step 3: Run local sidecar compile for host target**

Run: `rtk bun scripts/build-sidecar-binary.mjs`

Expected:

- Command prints `bun build ... --compile`.
- On this machine, output is `apps/desktop/src-tauri/binaries/lume-sidecar-aarch64-apple-darwin`.
- Exit code 0.

If `bun --compile` fails due a runtime bundling problem, stop and debug the compile error before continuing; do not reintroduce JS bundle fallback.

- [ ] **Step 4: Verify target override path**

Run:

```bash
rtk bun scripts/build-sidecar-binary.mjs --tauri-target aarch64-apple-darwin
```

Expected: same ARM output exists.

- [ ] **Step 5: Commit sidecar compiler script**

```bash
git add scripts/build-sidecar-binary.mjs
git commit -m "🔧 chore(desktop): 编译 standalone sidecar 发布二进制" \
  -m "恢复 bun --compile 输出 Tauri externalBin 所需的目标平台 sidecar 文件，移除 release JS bundle bridge 打包路径。" \
  -m "Constraint: 不引入新的运行时依赖" \
  -m "Tested: rtk bun scripts/build-sidecar-binary.mjs --tauri-target aarch64-apple-darwin"
```

Generated binaries under `apps/desktop/src-tauri/binaries/` are package inputs and are ignored by git; do not force-add them.

## Task 3: Switch Release Runtime to External Sidecar Binary

**Files:**
- Modify: `apps/desktop/src-tauri/src/main.rs`

- [ ] **Step 1: Add pure path resolver helpers**

Near the existing JS bundle sidecar helpers, add pure helpers:

```rust
fn bundled_sidecar_binary_base_name() -> &'static str {
    "lume-sidecar"
}

fn current_target_sidecar_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "lume-sidecar.exe"
    } else {
        "lume-sidecar"
    }
}

fn resolve_bundled_sidecar_binary_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let name = current_target_sidecar_name();
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(executable_dir) = current_exe.parent() {
            // Tauri externalBin is packaged next to the main executable.
            // macOS: Lume.app/Contents/MacOS/lume-sidecar
            // Windows: <install-dir>/lume-sidecar.exe
            let p = executable_dir.join(name);
            if p.exists() {
                return Some(p);
            }
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        // Defensive fallbacks for local app bundle layouts and future Tauri placement changes.
        for p in [
            resource_dir.join(name),
            resource_dir.join("binaries").join(name),
        ] {
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}
```

The primary expected packaged paths are concrete and must be preserved:

- macOS: `<Lume.app>/Contents/MacOS/lume-sidecar`
- Windows: `<install-dir>/lume-sidecar.exe`

The resource-dir fallbacks are defensive only; release must still fail rather than using JS bundle/source fallback when no external binary is found.

- [ ] **Step 2: Add `spawn_bundled_sidecar_binary`**

Add:

```rust
fn spawn_bundled_sidecar_binary(app: &tauri::AppHandle) -> Option<Child> {
    let sidecar_path = resolve_bundled_sidecar_binary_path(app)?;
    let mut process = Command::new(&sidecar_path);
    process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_sidecar_logging_env(&mut process);
    apply_natives_path_env(&mut process, app);
    let (skills_archive, skills_dir) = apply_default_skills_env(&mut process, app, &PathBuf::from(""));
    match process.spawn() {
        Ok(child) => {
            info!(
                "[desktop] sidecar process booted from bundled binary: {} (default-skills-archive={}, default-skills-dir={})",
                sidecar_path.display(),
                skills_archive.as_deref().unwrap_or("not-found"),
                skills_dir.as_deref().unwrap_or("not-found")
            );
            Some(child)
        }
        Err(error) => {
            error!(
                "[desktop] failed to spawn bundled sidecar binary: {error} (sidecar={})",
                sidecar_path.display()
            );
            None
        }
    }
}
```

- [ ] **Step 3: Make release mode use only the binary path**

Before changing `spawn_sidecar_default`, add a release gate to `spawn_sidecar_with_strategy` so env sidecar commands are debug-only:

```rust
fn should_allow_env_sidecar() -> bool {
    cfg!(debug_assertions)
}

fn spawn_sidecar_with_strategy(app: &tauri::AppHandle) -> Option<Child> {
    if !should_allow_env_sidecar() {
        return spawn_sidecar_default(app);
    }

    let prefer_env = env_flag_enabled("LUME_SIDECAR_PREFER_ENV");
    if prefer_env {
        return spawn_sidecar_from_env().or_else(|| spawn_sidecar_default(app));
    }

    if has_env_sidecar_cmd() && !LOGGED_ENV_CMD_IGNORED.swap(true, Ordering::Relaxed) {
        warn!(
            "[desktop] LUME_SIDECAR_CMD detected but ignored by default; set LUME_SIDECAR_PREFER_ENV=1 to prefer env sidecar command"
        );
    }

    spawn_sidecar_default(app).or_else(|| spawn_sidecar_from_env())
}
```

This seals release mode from `LUME_SIDECAR_CMD` and `LUME_SIDECAR_PREFER_ENV` fallback.

Change the release block in `spawn_sidecar_default` from JS bundle first:

```rust
if !cfg!(debug_assertions) {
    if let Some(child) = spawn_bundled_sidecar_js(app) {
        return Some(child);
    }
    warn!("[desktop] bundled JS sidecar not found, falling back to development sidecar path");
}
```

To binary-only release behavior:

```rust
if !cfg!(debug_assertions) {
    if let Some(child) = spawn_bundled_sidecar_binary(app) {
        return Some(child);
    }
    error!("[desktop] bundled sidecar binary not found or failed to spawn");
    return None;
}
```

- [ ] **Step 4: Keep development path intact**

Leave the existing local Bun/source path after the release block. If JS bridge helpers become unused, either:

- Keep them only if development macOS still calls them, or
- Delete release-only JS bundle helpers if they are now fully unused.

Do not delete local dev bridge behavior unless compile errors prove it is dead.

- [ ] **Step 5: Add/adjust Rust unit tests for pure helpers**

In the existing `#[cfg(test)] mod tests`, add tests for pure naming helpers:

```rust
#[test]
fn bundled_sidecar_binary_base_name_matches_tauri_external_bin() {
    assert_eq!(bundled_sidecar_binary_base_name(), "lume-sidecar");
}
```

For OS-specific executable name, use cfg blocks:

```rust
#[test]
fn current_target_sidecar_name_matches_platform() {
    #[cfg(target_os = "windows")]
    assert_eq!(current_target_sidecar_name(), "lume-sidecar.exe");
    #[cfg(not(target_os = "windows"))]
    assert_eq!(current_target_sidecar_name(), "lume-sidecar");
}
```

Also add:

```rust
#[test]
fn env_sidecar_is_debug_only() {
    assert_eq!(should_allow_env_sidecar(), cfg!(debug_assertions));
}
```

Expose helpers to tests through the existing `use super::{ ... }` import list.

- [ ] **Step 6: Run focused Rust test**

Run:

```bash
cd apps/desktop/src-tauri && rtk cargo test bundled_sidecar_binary_base_name_matches_tauri_external_bin current_target_sidecar_name_matches_platform
```

Expected: PASS.

If Cargo does not accept two test filters, run them individually:

```bash
cd apps/desktop/src-tauri && rtk cargo test bundled_sidecar_binary_base_name_matches_tauri_external_bin
cd apps/desktop/src-tauri && rtk cargo test current_target_sidecar_name_matches_platform
cd apps/desktop/src-tauri && rtk cargo test env_sidecar_is_debug_only
```

- [ ] **Step 7: Commit runtime switch**

```bash
git add apps/desktop/src-tauri/src/main.rs
git commit -m "🐛 fix(desktop): release 启动 standalone sidecar" \
  -m "Release 模式只启动 Tauri externalBin 打包的 sidecar 二进制，避免用户机器缺少 node/bun 时后端无法启动。" \
  -m "Constraint: debug 模式保留本地 Bun/source 启动路径" \
  -m "Tested: cd apps/desktop/src-tauri && rtk cargo test bundled_sidecar_binary_base_name_matches_tauri_external_bin" \
  -m "Tested: cd apps/desktop/src-tauri && rtk cargo test current_target_sidecar_name_matches_platform" \
  -m "Tested: cd apps/desktop/src-tauri && rtk cargo test env_sidecar_is_debug_only"
```

## Task 4: Add Pre-Package Input Verifier

**Files:**
- Create: `scripts/verify-desktop-package-inputs.mjs`

- [ ] **Step 1: Create verifier script**

Create `scripts/verify-desktop-package-inputs.mjs`:

```js
import { existsSync, statSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = {
  "aarch64-apple-darwin": "lume-sidecar-aarch64-apple-darwin",
  "x86_64-apple-darwin": "lume-sidecar-x86_64-apple-darwin",
  "x86_64-pc-windows-msvc": "lume-sidecar-x86_64-pc-windows-msvc.exe",
};

const target = process.env.TAURI_TARGET_TRIPLE;
const binaryName = TARGETS[target];
if (!binaryName) fail(`unsupported or missing TAURI_TARGET_TRIPLE: ${target ?? "(unset)"}`);

const tauriDir = resolve(REPO_ROOT, "apps", "desktop", "src-tauri");
const requiredInputs = [
  resolve(tauriDir, "binaries", binaryName),
  resolve(tauriDir, "binaries", "lume-natives.node"),
  resolve(tauriDir, "resources", "default-skills.tar"),
];
for (const file of requiredInputs) {
  if (!existsSync(file)) fail(`missing required package input: ${file}`);
}

if (target !== "x86_64-pc-windows-msvc") {
  const mode = statSync(resolve(tauriDir, "binaries", binaryName)).mode;
  if ((mode & 0o111) === 0) fail(`sidecar binary is not executable: ${binaryName}`);
}

const configPath = resolve(tauriDir, "tauri.conf.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const externalBin = config?.bundle?.externalBin ?? [];
const resources = config?.bundle?.resources ?? [];
if (JSON.stringify(externalBin) !== JSON.stringify(["binaries/lume-sidecar"])) {
  fail(`tauri.conf.json externalBin must be ["binaries/lume-sidecar"]`);
}
for (const required of ["resources/default-skills.tar", "binaries/lume-natives.node"]) {
  if (!resources.includes(required)) fail(`tauri.conf.json resources missing ${required}`);
}
const forbidden = ["lume-sidecar.js", "sidecar-node-bridge.mjs", "sidecar-node-modules.zip"];
const leaked = resources.filter((item) => forbidden.some((needle) => item.includes(needle)));
if (leaked.length) fail(`release resources include JS bridge artifacts: ${leaked.join(", ")}`);

console.error(`[verify-package-inputs] ok for ${target}`);

function fail(message) {
  console.error(`[verify-package-inputs] ${message}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run verifier before resources exist to confirm failure, if safe**

If `apps/desktop/src-tauri/binaries/lume-sidecar-aarch64-apple-darwin` has not been generated:

Run: `TAURI_TARGET_TRIPLE=aarch64-apple-darwin rtk bun scripts/verify-desktop-package-inputs.mjs`

Expected: FAIL with `missing required package input`.

If resources already exist, skip this failure check and note it in final task notes.

- [ ] **Step 3: Run verifier after resource scripts**

Run:

```bash
TAURI_TARGET_TRIPLE=aarch64-apple-darwin rtk bun scripts/build-natives-binary.mjs
TAURI_TARGET_TRIPLE=aarch64-apple-darwin rtk bun scripts/build-sidecar-binary.mjs
rtk bun scripts/build-default-skills-archive.mjs
TAURI_TARGET_TRIPLE=aarch64-apple-darwin rtk bun scripts/verify-desktop-package-inputs.mjs
```

Expected: final command prints `ok for aarch64-apple-darwin`.

- [ ] **Step 4: Commit verifier**

```bash
git add scripts/verify-desktop-package-inputs.mjs
git commit -m "✅ test(desktop): 校验 release 打包输入合同" \
  -m "新增 package input verifier，在 Tauri 打包前检查 standalone sidecar、native logger、default skills 与 tauri.conf release 合同。" \
  -m "Tested: TAURI_TARGET_TRIPLE=aarch64-apple-darwin rtk bun scripts/verify-desktop-package-inputs.mjs"
```

## Task 5: Add Compiled Sidecar Smoke Test

**Files:**
- Create: `scripts/smoke-compiled-sidecar.mjs`

- [ ] **Step 1: Create smoke script**

Create `scripts/smoke-compiled-sidecar.mjs`:

```js
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = {
  "aarch64-apple-darwin": "lume-sidecar-aarch64-apple-darwin",
  "x86_64-apple-darwin": "lume-sidecar-x86_64-apple-darwin",
  "x86_64-pc-windows-msvc": "lume-sidecar-x86_64-pc-windows-msvc.exe",
};

const target = process.env.TAURI_TARGET_TRIPLE;
const binaryName = TARGETS[target];
if (!binaryName) fail(`unsupported or missing TAURI_TARGET_TRIPLE: ${target ?? "(unset)"}`);

const tauriDir = resolve(REPO_ROOT, "apps", "desktop", "src-tauri");
const sidecarPath = resolve(tauriDir, "binaries", binaryName);
const nativesPath = resolve(tauriDir, "binaries", "lume-natives.node");
const skillsArchive = resolve(tauriDir, "resources", "default-skills.tar");
for (const file of [sidecarPath, nativesPath, skillsArchive]) {
  if (!existsSync(file)) fail(`missing smoke input: ${file}`);
}

const configHome = mkdtempSync(join(tmpdir(), "lume-compiled-sidecar-smoke-"));
const smokeCwd = mkdtempSync(join(tmpdir(), "lume-compiled-sidecar-cwd-"));
const child = spawn(sidecarPath, [], {
  cwd: smokeCwd,
  env: {
    ...process.env,
    LUME_CONFIG_DIR: configHome,
    LUME_NATIVES_PATH: nativesPath,
    LUME_DEFAULT_SKILLS_ARCHIVE: skillsArchive,
    LUME_LOG_CONSOLE: "true",
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
const timeout = setTimeout(() => {
  child.kill();
  cleanup();
  fail(`healthcheck timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}, 15_000);

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        clearTimeout(timeout);
        child.kill();
        cleanup();
        if (msg.error) fail(`healthcheck returned error: ${JSON.stringify(msg.error)}`);
        if (msg.result?.ok !== true) fail(`healthcheck returned unexpected result: ${JSON.stringify(msg.result)}`);
        console.error(`[smoke-compiled-sidecar] ok for ${target}`);
        process.exit(0);
      }
    } catch {}
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  cleanup();
  fail(`sidecar exited before healthcheck (code=${code}, signal=${signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});

child.stdin.write(`${JSON.stringify({ id: 1, method: "healthcheck", params: null })}\n`);

function cleanup() {
  rmSync(configHome, { recursive: true, force: true });
  rmSync(smokeCwd, { recursive: true, force: true });
}

function fail(message) {
  console.error(`[smoke-compiled-sidecar] ${message}`);
  process.exit(1);
}
```

- [ ] **Step 2: Run smoke against generated ARM sidecar**

Run:

```bash
TAURI_TARGET_TRIPLE=aarch64-apple-darwin rtk bun scripts/smoke-compiled-sidecar.mjs
```

Expected: `ok for aarch64-apple-darwin`

If this fails due `bun --compile` virtual filesystem issues, stop and debug the sidecar dependency that is not compile-safe. Do not weaken the release contract.

- [ ] **Step 3: Commit smoke script**

```bash
git add scripts/smoke-compiled-sidecar.mjs
git commit -m "✅ test(desktop): smoke standalone sidecar 发布二进制" \
  -m "新增 compiled sidecar smoke，在 CI 打包前以 release 环境变量启动二进制并调用 healthcheck。" \
  -m "Tested: TAURI_TARGET_TRIPLE=aarch64-apple-darwin rtk bun scripts/smoke-compiled-sidecar.mjs"
```

## Task 6: Add Local and Remote Artifact Verifiers

**Files:**
- Create: `scripts/verify-desktop-package-artifacts.mjs`
- Create: `scripts/verify-release-assets.mjs`

- [ ] **Step 1: Create local artifact verifier**

Create `scripts/verify-desktop-package-artifacts.mjs` with these rules:

```js
import { existsSync, readdirSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.TAURI_TARGET_TRIPLE;
const roots = {
  "aarch64-apple-darwin": resolve(REPO_ROOT, "apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle"),
  "x86_64-apple-darwin": resolve(REPO_ROOT, "apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle"),
  "x86_64-pc-windows-msvc": resolve(REPO_ROOT, "apps/desktop/src-tauri/target/release/bundle"),
};
const required = {
  "aarch64-apple-darwin": [/\/macos\/.*\.app$/, /\/macos\/.*\.app\/Contents\/MacOS\/lume-sidecar$/, /\/macos\/.*\.app\.tar\.gz$/, /\/macos\/.*\.app\.tar\.gz\.sig$/, /\/dmg\/.*\.dmg$/],
  "x86_64-apple-darwin": [/\/macos\/.*\.app$/, /\/macos\/.*\.app\/Contents\/MacOS\/lume-sidecar$/, /\/macos\/.*\.app\.tar\.gz$/, /\/macos\/.*\.app\.tar\.gz\.sig$/, /\/dmg\/.*\.dmg$/],
  "x86_64-pc-windows-msvc": [/\/nsis\/.*\.exe$/, /\/nsis\/.*\.exe\.sig$/],
};

const root = roots[target];
if (!root) fail(`unsupported or missing TAURI_TARGET_TRIPLE: ${target ?? "(unset)"}`);
const files = walk(root);
for (const pattern of required[target]) {
  if (!files.some((file) => pattern.test(file))) fail(`missing artifact matching ${pattern} under ${root}`);
}
writeSummary(`Local package artifacts for ${target}`, files);
console.error(`[verify-package-artifacts] ok for ${target}`);

function walk(dir) {
  if (!existsSync(dir)) fail(`bundle directory missing: ${dir}`);
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(toPosix(full));
      out.push(...walk(full));
    } else {
      out.push(toPosix(full));
    }
  }
  return out;
}

function toPosix(file) {
  return file.replaceAll("\\", "/");
}

function writeSummary(title, files) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  appendFileSync(summary, `\n### ${title}\n` + files.map((file) => `- ${file}`).join("\n") + "\n");
}

function fail(message) {
  console.error(`[verify-package-artifacts] ${message}`);
  process.exit(1);
}
```

- [ ] **Step 2: Create remote release verifier**

Create `scripts/verify-release-assets.mjs`:

```js
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
if (!tag) fail("missing tag name");
if (!process.env.GH_TOKEN) fail("missing GH_TOKEN");

const release = ghJson(["release", "view", tag, "--json", "assets,isDraft"]);
if (!release.isDraft) fail(`release ${tag} is not draft`);
const names = (release.assets ?? []).map((asset) => asset.name);

requireAsset("macOS ARM dmg", names, [/\.dmg$/i], [/aarch64|arm64/i]);
requireAsset("macOS ARM updater archive", names, [/\.app\.tar\.gz$/i], [/aarch64|arm64/i]);
requireAsset("macOS ARM updater signature", names, [/\.app\.tar\.gz\.sig$/i], [/aarch64|arm64/i]);
requireAsset("macOS Intel dmg", names, [/\.dmg$/i], [/x86_64|x64/i]);
requireAsset("macOS Intel updater archive", names, [/\.app\.tar\.gz$/i], [/x86_64|x64/i]);
requireAsset("macOS Intel updater signature", names, [/\.app\.tar\.gz\.sig$/i], [/x86_64|x64/i]);
requireAsset("Windows NSIS installer", names, [/\.exe$/i], []);
requireAsset("Windows NSIS signature", names, [/\.exe\.sig$/i], []);
requireAsset("latest.json", names, [/^latest\.json$/i], []);

const latestJson = ghText(["release", "download", tag, "--pattern", "latest.json", "--output", "-"]);
const latest = JSON.parse(latestJson);
const platformEntries = collectLatestJsonEntries(latest);
requireLatestCoverage("macOS ARM", platformEntries, [/darwin|macos/i, /aarch64|arm64/i]);
requireLatestCoverage("macOS Intel", platformEntries, [/darwin|macos/i, /x86_64|x64/i]);
requireLatestCoverage("Windows x64", platformEntries, [/windows|win32|msvc/i, /x86_64|x64/i]);

writeSummary(names);
console.error(`[verify-release-assets] ok for ${tag}`);

function requireAsset(label, names, requiredPatterns, optionalArchPatterns) {
  const found = names.some((name) => {
    const hasRequired = requiredPatterns.every((pattern) => pattern.test(name));
    const hasArch = optionalArchPatterns.length === 0 || optionalArchPatterns.some((pattern) => pattern.test(name));
    return hasRequired && hasArch;
  });
  if (!found) fail(`missing remote asset: ${label}\nassets:\n${names.join("\n")}`);
}

function collectLatestJsonEntries(value, path = "$", entries = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLatestJsonEntries(item, `${path}[${index}]`, entries));
    return entries;
  }
  if (value && typeof value === "object") {
    const record = value;
    const url = typeof record.url === "string" ? record.url : "";
    const signature = typeof record.signature === "string" ? record.signature : "";
    const notes = typeof record.notes === "string" ? record.notes : "";
    const payload = `${path} ${url} ${signature} ${notes}`;
    if (url || signature) entries.push(payload);
    for (const [key, item] of Object.entries(record)) {
      collectLatestJsonEntries(item, `${path}.${key}`, entries);
    }
  }
  return entries;
}

function requireLatestCoverage(label, entries, patterns) {
  const found = entries.some((entry) => patterns.every((pattern) => pattern.test(entry)));
  if (!found) fail(`latest.json missing updater coverage for ${label}\nentries:\n${entries.join("\n")}`);
}

function ghJson(args) {
  return JSON.parse(ghText(args));
}

function ghText(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) fail(`gh ${args.join(" ")} failed\n${result.stderr}`);
  return result.stdout;
}

function writeSummary(names) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  appendFileSync(summary, `\n### Remote release assets\n` + names.map((name) => `- ${name}`).join("\n") + "\n");
}

function fail(message) {
  console.error(`[verify-release-assets] ${message}`);
  process.exit(1);
}
```

If `gh release download --output -` does not stream asset content reliably in Actions, adjust implementation to download `latest.json` to a temp directory and read the file. Keep the script interface unchanged.

- [ ] **Step 3: Run local artifact verifier against absent outputs to confirm failure**

Run:

```bash
TAURI_TARGET_TRIPLE=aarch64-apple-darwin rtk bun scripts/verify-desktop-package-artifacts.mjs
```

Expected: FAIL if no Tauri bundle has been built. This is acceptable before full packaging.

- [ ] **Step 4: Syntax-check remote verifier without GitHub token**

Run:

```bash
rtk bun scripts/verify-release-assets.mjs v0.0.0
```

Expected: FAIL with `missing GH_TOKEN`, not a syntax error.

- [ ] **Step 5: Commit verifiers**

```bash
git add scripts/verify-desktop-package-artifacts.mjs scripts/verify-release-assets.mjs
git commit -m "✅ test(desktop): 校验 release 本地与远端产物" \
  -m "新增本地 Tauri bundle 产物检查和远端 GitHub Release assets 检查，作为自动发布前的门禁。" \
  -m "Tested: TAURI_TARGET_TRIPLE=aarch64-apple-darwin rtk bun scripts/verify-desktop-package-artifacts.mjs (expected fail without bundle)" \
  -m "Tested: rtk bun scripts/verify-release-assets.mjs v0.0.0 (expected fail without GH_TOKEN)"
```

## Chunk 2: GitHub Workflow, Docs, Final Verification

## Task 7: Rewrite GitHub Release Workflow

**Files:**
- Modify: `.github/workflows/release-desktop.yml`

- [ ] **Step 1: Remove manual dispatch**

Remove:

```yaml
workflow_dispatch:
```

Keep only:

```yaml
on:
  push:
    tags:
      - "v*"
```

- [ ] **Step 2: Add `prepare-release` job**

Add a first job:

```yaml
  prepare-release:
    name: Prepare Release
    runs-on: ubuntu-latest
    outputs:
      release_id: ${{ steps.release.outputs.release_id }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Create or reuse draft release
        id: release
        env:
          GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}
        shell: bash
        run: |
          set -euo pipefail
          case "${GITHUB_REF}" in
            refs/tags/v*) ;;
            *) echo "Release workflow must run from a v* tag"; exit 1 ;;
          esac
          notes="docs/release/${GITHUB_REF_NAME}.md"
          if [ ! -f "$notes" ]; then
            echo "Missing release notes: $notes"
            exit 1
          fi
          if gh release view "${GITHUB_REF_NAME}" --json isDraft >/tmp/release.json 2>/dev/null; then
            if [ "$(jq -r '.isDraft' /tmp/release.json)" != "true" ]; then
              echo "Release ${GITHUB_REF_NAME} is already published"; exit 1
            fi
            gh release edit "${GITHUB_REF_NAME}" --title "Lume ${GITHUB_REF_NAME}" --notes-file "$notes"
            gh release view "${GITHUB_REF_NAME}" --json assets --jq '.assets[].name' | while read -r asset_name; do
              [ -z "$asset_name" ] || gh release delete-asset "${GITHUB_REF_NAME}" "$asset_name" --yes
            done
          else
            gh release create "${GITHUB_REF_NAME}" --draft --verify-tag --title "Lume ${GITHUB_REF_NAME}" --notes-file "$notes"
          fi
          release_id="$(gh release view "${GITHUB_REF_NAME}" --json databaseId --jq '.databaseId')"
          echo "release_id=${release_id}" >> "$GITHUB_OUTPUT"
```

GitHub-hosted Ubuntu includes `jq`; if not available, use `gh --jq` only.

- [ ] **Step 3: Convert platform jobs to depend on `prepare-release`**

Rename jobs:

- `release-macos` → `build-macos-arm`
- `release-macos-intel` → `build-macos-intel`
- `release-windows` → `build-windows`

Add:

```yaml
needs: prepare-release
```

- [ ] **Step 4: Set runner labels**

Use:

```yaml
runs-on: macos-15
```

for ARM, and:

```yaml
runs-on: macos-15-intel
```

for Intel.

- [ ] **Step 5: Add package input and sidecar smoke steps**

After `Prepare desktop bundle resources`, add:

```yaml
      - name: Verify desktop package inputs
        env:
          TAURI_TARGET_TRIPLE: aarch64-apple-darwin
        run: bun scripts/verify-desktop-package-inputs.mjs
      - name: Smoke compiled sidecar
        env:
          TAURI_TARGET_TRIPLE: aarch64-apple-darwin
        run: bun scripts/smoke-compiled-sidecar.mjs
```

Use each job's target triple.

- [ ] **Step 6: Update `tauri-action` upload inputs**

Before updating `tauri-action`, remove the old per-platform `Read release notes` steps. `prepare-release` owns release title/body, so platform jobs must not keep `releaseName` or `releaseBody` inputs.

Each platform job should set:

```yaml
env:
  GITHUB_TOKEN: ${{ secrets.RELEASE_TOKEN }}
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
  LUME_UPDATER_PUBLIC_KEY: ${{ vars.LUME_UPDATER_PUBLIC_KEY }}
  TAURI_TARGET_TRIPLE: <target>
with:
  projectPath: apps/desktop
  releaseId: ${{ needs.prepare-release.outputs.release_id }}
  tagName: ${{ github.ref_name }}
  releaseDraft: true
  prerelease: false
  args: <platform args>
  updaterJsonPreferNsis: true
```

Platform args:

- ARM macOS: `--target aarch64-apple-darwin --config src-tauri/tauri.release.conf.json`
- Intel macOS: `--target x86_64-apple-darwin --config src-tauri/tauri.release.conf.json`
- Windows: `--config src-tauri/tauri.release.conf.json`

Do not set `releaseBody` here; `prepare-release` owns release body.

- [ ] **Step 7: Add local artifact verification after `tauri-action`**

Add:

```yaml
      - name: Verify package artifacts
        env:
          TAURI_TARGET_TRIPLE: <target>
        run: bun scripts/verify-desktop-package-artifacts.mjs
```

- [ ] **Step 8: Add remote verification job**

```yaml
  verify-release-assets:
    name: Verify Release Assets
    needs: [build-macos-arm, build-macos-intel, build-windows]
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.13
      - name: Verify uploaded release assets
        env:
          GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}
          GITHUB_REF_NAME: ${{ github.ref_name }}
        run: bun scripts/verify-release-assets.mjs
```

- [ ] **Step 9: Update publish job dependency and token**

```yaml
  publish-release:
    name: Publish Release
    needs: verify-release-assets
    if: success() && startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Publish draft release
        env:
          GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}
        run: |
          echo "Publishing release for tag ${{ github.ref_name }}"
          gh release edit "${{ github.ref_name }}" --draft=false
```

- [ ] **Step 10: Validate workflow syntax by inspection**

Run:

```bash
rtk sed -n '1,420p' .github/workflows/release-desktop.yml
rtk rg -n "workflow_dispatch|releaseBody|releaseName|macos-latest" .github/workflows/release-desktop.yml
rtk rg -n "prepare-release|releaseId|verify-desktop-package-inputs|smoke-compiled-sidecar|verify-release-assets|publish-release|permissions:|contents: write|macos-15-intel|macos-15" .github/workflows/release-desktop.yml
```

Expected:

- The second command finds no matches and exits non-zero; this is expected for forbidden old fields.
- The third command finds all required workflow invariants.
- No `workflow_dispatch`.
- Top-level `permissions: contents: write`.
- `prepare-release` exists.
- Build jobs depend on `prepare-release`.
- macOS ARM uses `macos-15`; macOS Intel uses `macos-15-intel`.
- Package input verifier and compiled sidecar smoke steps exist in each platform job.
- `releaseId` is passed to `tauri-action`.
- Platform jobs do not include `releaseName`, `releaseBody`, or old `Read release notes` steps.
- `verify-release-assets` exists.
- `verify-release-assets` sets up Bun before running the verifier script.
- `publish-release` depends on `verify-release-assets`.

- [ ] **Step 11: Commit workflow**

```bash
git add .github/workflows/release-desktop.yml
git commit -m "🚀 release(desktop): 重构自包含发布流水线" \
  -m "GitHub Actions 改为单 draft release 所有权、三平台构建与 smoke、本地/远端资产验证、最终自动发布。" \
  -m "Constraint: workflow 只能从 v* tag 自动发布" \
  -m "Constraint: release mutation 统一使用 RELEASE_TOKEN" \
  -m "Not-tested: GitHub Actions release requires repository secrets and tag trigger"
```

## Task 8: Update Release Documentation

**Files:**
- Modify: `docs/release/desktop-release.md`

- [ ] **Step 1: Replace stale bundled sidecar section**

Replace the current "Bundled Sidecar" section with:

```markdown
## Bundled Sidecar

Release builds compile `apps/sidecar/src/index.ts` into a standalone Bun executable before Tauri packaging.

Generated files:

| Platform | File |
|---|---|
| macOS ARM | `apps/desktop/src-tauri/binaries/lume-sidecar-aarch64-apple-darwin` |
| macOS Intel | `apps/desktop/src-tauri/binaries/lume-sidecar-x86_64-apple-darwin` |
| Windows x64 | `apps/desktop/src-tauri/binaries/lume-sidecar-x86_64-pc-windows-msvc.exe` |

Tauri packages the sidecar through `bundle.externalBin = ["binaries/lume-sidecar"]`.
Release users do not need system `node` or system `bun`.
Development builds still use the local Bun/source sidecar path for fast iteration.
```

- [ ] **Step 2: Update release flow section**

Document:

- Release workflow triggers only on `v*` tags.
- `RELEASE_TOKEN` is required for all GitHub Release mutation (`gh` CLI and `tauri-action` upload).
- `prepare-release` creates/reuses a single draft release.
- Platform jobs upload to that release id.
- `verify-release-assets` checks uploaded assets and `latest.json`.
- `publish-release` auto-publishes after all gates pass.
- Linux is not part of the current release gate.

- [ ] **Step 3: Commit docs**

```bash
git add docs/release/desktop-release.md
git commit -m "📝 docs(desktop): 更新桌面发布合同说明" \
  -m "同步 standalone sidecar、externalBin、单 draft release 与三平台自动发布门禁。" \
  -m "Not-tested: 文档变更"
```

## Task 9: Final Verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Run focused script checks**

Run:

```bash
TAURI_TARGET_TRIPLE=aarch64-apple-darwin rtk bun scripts/verify-desktop-package-inputs.mjs
TAURI_TARGET_TRIPLE=aarch64-apple-darwin rtk bun scripts/smoke-compiled-sidecar.mjs
rtk bun scripts/verify-release-assets.mjs v0.0.0
```

Expected:

- First two pass if local compiled resources exist.
- Third fails with `missing GH_TOKEN`; that is the expected local check.

- [ ] **Step 2: Run focused Rust tests**

Run:

```bash
cd apps/desktop/src-tauri && rtk cargo test bundled_sidecar_binary_base_name_matches_tauri_external_bin
cd apps/desktop/src-tauri && rtk cargo test current_target_sidecar_name_matches_platform
```

Expected: PASS.

- [ ] **Step 3: Run diff check**

Run:

```bash
rtk git diff --check
```

Expected: no output.

- [ ] **Step 4: Inspect final status**

Run:

```bash
rtk git status --short
```

Expected: only intentional generated binaries may be untracked/ignored. No unstaged source/doc/workflow/script changes.

- [ ] **Step 5: Final report**

Include:

- Changed files.
- Simplifications made.
- Verification commands and results.
- Remaining risks:
  - Full macOS Intel/Windows CI can only be verified in GitHub Actions.
  - `bun --compile` may expose dependency filesystem issues; the smoke gate is designed to catch them before publish.
