# Desktop Release CI Redesign

- **Date**: 2026-06-18
- **Status**: Design approved, pending spec review
- **Scope**: GitHub Actions desktop release pipeline and the release packaging contract for macOS ARM, macOS Intel, and Windows x64.

## 1. Background

Recent release attempts exposed that the current desktop release path is too easy to ship without a working sidecar:

- The current release packaging path builds `lume-sidecar.js`, `sidecar-node-bridge.mjs`, and `sidecar-node-modules.zip`.
- Runtime release startup then depends on a system `node` and system `bun` being present on the user's machine.
- macOS can fail before sidecar boot if `node` is missing.
- Windows has already required multiple fixes around `\\?\` paths and Node's entrypoint/path handling.
- The release workflow builds platform artifacts, but does not currently enforce the actual packaging contract before publishing.
- `docs/release/desktop-release.md` still describes the older standalone Bun executable design, while the current code follows the JS bundle bridge path.

The release system should return to one clear contract:

> A release install of Lume starts its sidecar without requiring the user's machine to have `node` or `bun` installed.

## 2. Goals

- Release artifacts are self-contained for macOS ARM, macOS Intel, and Windows x64.
- Restore the standalone compiled sidecar as the release runtime.
- Use Tauri `externalBin` for the sidecar, matching Tauri's platform-specific binary packaging model.
- Add CI gates that verify package inputs, compiled sidecar startup, and final package artifacts.
- Automatically publish the release only after all three platform jobs pass.
- Keep local development fast and unchanged where possible.

## 3. Non-Goals

- Linux release is not part of this release gate.
- This design does not introduce notarization changes, signing key rotation, or updater endpoint changes.
- This design does not add a new release notes generation workflow; it reuses `docs/release/<tag>.md`.
- This design does not keep the JS bundle bridge as a release fallback.
- This design does not rewrite sidecar internals beyond changes required to make the compiled release binary verifiably boot.

## 4. Locked Decisions

| Dimension | Decision |
|---|---|
| Platforms | macOS ARM, macOS Intel, Windows x64 |
| Release publish mode | Auto-publish after all platform jobs pass |
| Sidecar release runtime | `bun build --compile` standalone binary |
| Tauri packaging mechanism | `bundle.externalBin` |
| User machine runtime requirement | No system `node`; no system `bun` |
| Linux | Out of current release gate |
| JS bundle bridge | Development/debug path only, not release contract |

## 5. Release Packaging Contract

### 5.1 Tauri Configuration

`apps/desktop/src-tauri/tauri.conf.json` should define release inputs around `externalBin`:

```json
{
  "bundle": {
    "externalBin": ["binaries/lume-sidecar"],
    "resources": [
      "resources/default-skills.tar",
      "binaries/lume-natives.node"
    ]
  }
}
```

`externalBin` belongs in the base `tauri.conf.json` because the release contract is shared by local package builds and GitHub release builds. `apps/desktop/src-tauri/tauri.release.conf.json` should remain a release overlay for release-only behavior such as `createUpdaterArtifacts: true`; it should not redefine the sidecar packaging contract.

The release contract must not require these JS bridge resources:

- `binaries/lume-sidecar.js`
- `binaries/sidecar-node-bridge.mjs`
- `binaries/sidecar-node-modules.zip`

Those files may exist for development or diagnostic work, but CI must fail if they are part of the required release resources.

### 5.2 Sidecar Binary Names

`scripts/build-sidecar-binary.mjs` should create the platform-specific file expected by Tauri:

| Platform | Target triple | Output file |
|---|---|---|
| macOS ARM | `aarch64-apple-darwin` | `apps/desktop/src-tauri/binaries/lume-sidecar-aarch64-apple-darwin` |
| macOS Intel | `x86_64-apple-darwin` | `apps/desktop/src-tauri/binaries/lume-sidecar-x86_64-apple-darwin` |
| Windows x64 | `x86_64-pc-windows-msvc` | `apps/desktop/src-tauri/binaries/lume-sidecar-x86_64-pc-windows-msvc.exe` |

The script should use:

```bash
bun build apps/sidecar/src/index.ts --compile --target=<bun-target> --outfile=<output>
```

Target mapping:

| Tauri target triple | Bun compile target |
|---|---|
| `aarch64-apple-darwin` | `bun-darwin-arm64` |
| `x86_64-apple-darwin` | `bun-darwin-x64` |
| `x86_64-pc-windows-msvc` | `bun-windows-x64` |

The script should read the target in this order:

1. `--tauri-target <triple>` CLI argument.
2. `TAURI_TARGET_TRIPLE` environment variable.
3. Host platform fallback for local development.

Windows should include `--windows-hide-console` and `--windows-title=Lume Sidecar`. macOS binaries should be marked executable.

### 5.3 Native Logger Module

`scripts/build-natives-binary.mjs` remains responsible for building and copying:

```text
apps/desktop/src-tauri/binaries/lume-natives.node
```

The desktop shell continues to pass `LUME_NATIVES_PATH` to the sidecar process.

### 5.4 Default Skills Archive

`scripts/build-default-skills-archive.mjs` remains responsible for producing:

```text
apps/desktop/src-tauri/resources/default-skills.tar
```

The desktop shell continues to pass `LUME_DEFAULT_SKILLS_ARCHIVE` to the sidecar process.

## 6. Runtime Startup Strategy

### 6.1 Release Mode

Runtime startup is owned by the Rust desktop shell in `apps/desktop/src-tauri/src/main.rs`.

In release builds, `spawn_sidecar_default(app)` should take the compiled external sidecar path. The implementation should add or restore a `spawn_bundled_sidecar_binary(app)` helper and call it before any development fallback.

Required behavior:

- Resolve the platform-specific external sidecar binary packaged by Tauri.
- Spawn the standalone sidecar with piped stdin/stdout/stderr.
- Apply logging env and release resource env (`LUME_NATIVES_PATH`, `LUME_DEFAULT_SKILLS_ARCHIVE`).
- If the external sidecar is missing or fails to spawn, log a clear error and surface sidecar startup failure.
- Do not fall back to `apps/sidecar/src/index.ts`, system `bun`, system `node`, or the JS bridge in release builds.

Release-vs-development switch:

| Build mode | Runtime owner | Sidecar path |
|---|---|---|
| Release (`!cfg!(debug_assertions)`) | Rust desktop shell | Packaged external sidecar binary |
| Development (`cfg!(debug_assertions)`) | Rust desktop shell | Local `apps/sidecar` source/dist entry via local `bun` |

### 6.2 Development Mode

Development mode can keep the existing local sidecar path:

- Prefer source or built JS entrypoint under `apps/sidecar`.
- Use local `bun` for fast iteration.
- Keep bridge behavior only where it is still useful for local macOS development.

The development path must not weaken the release invariant.

## 7. GitHub Actions Design

### 7.0 Triggers

The release workflow should auto-publish only from version tags:

```yaml
on:
  push:
    tags:
      - "v*"

permissions:
  contents: write
```

`workflow_dispatch` should be removed from this auto-publish workflow. A manual branch run must not be able to create or publish a release named after a branch. Manual releases should use the same path as automated releases: create and push a `v*` tag.

All jobs that read, create, upload to, verify, or publish GitHub Releases must use `secrets.RELEASE_TOKEN` as the single credential source:

| Context | Env var |
|---|---|
| `gh` CLI steps | `GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}` |
| `tauri-action` steps | `GITHUB_TOKEN: ${{ secrets.RELEASE_TOKEN }}` |

The workflow-level `permissions: contents: write` remains required, but release mutation should not mix default `GITHUB_TOKEN` and `RELEASE_TOKEN`.

### 7.1 Jobs

The workflow should have one release-preparation job, three build jobs, one remote verification job, and one publish job:

| Job | Runner | Target |
|---|---|---|
| `prepare-release` | `ubuntu-latest` | Creates one draft GitHub Release and outputs its release id |
| `build-macos-arm` | `macos-15` | `aarch64-apple-darwin` |
| `build-macos-intel` | `macos-15-intel` | `x86_64-apple-darwin` |
| `build-windows` | `windows-latest` | `x86_64-pc-windows-msvc` |
| `verify-release-assets` | `ubuntu-latest` | Verifies the single draft release has all required uploaded assets |
| `publish-release` | `ubuntu-latest` | Publishes the draft release |

The build jobs depend on `prepare-release`. `verify-release-assets` depends on all three build jobs. `publish-release` depends on `verify-release-assets` and runs only when every prior job passes.

The macOS runner labels are explicit so the compiled sidecar smoke test runs on the same architecture it ships for. Do not use `macos-latest` for the Intel job.

### 7.1.1 Prepare Release

`prepare-release` is the only job allowed to create a GitHub Release.

It should:

1. Check out the repository.
2. Verify the ref is a `refs/tags/v*` tag.
3. Verify `docs/release/${{ github.ref_name }}.md` exists.
4. Create or validate a draft release for the tag.
5. Output the GitHub release id for downstream jobs.

Release creation command:

```bash
gh release create "${{ github.ref_name }}" \
  --draft \
  --verify-tag \
  --title "Lume ${{ github.ref_name }}" \
  --notes-file "docs/release/${{ github.ref_name }}.md"
```

Rerun behavior:

- If the release does not exist, create it as a draft.
- If the release exists and is still draft, reuse it only after refreshing metadata and deleting all existing assets on that draft release.
- If the release exists and is already published, fail instead of mutating it.

The release id can be read with `gh release view "${{ github.ref_name }}" --json databaseId`.

Draft reuse must also refresh release metadata:

- Title must be set to `Lume ${{ github.ref_name }}`.
- Body must be replaced from `docs/release/${{ github.ref_name }}.md`.
- Existing assets must be deleted before platform jobs run so reruns cannot publish stale or mixed artifacts.

Asset cleanup should enumerate `gh release view "${{ github.ref_name }}" --json assets` and delete every existing asset with `gh release delete-asset <asset-id> --yes`.

### 7.2 Per-Platform Build Flow

Each platform job should follow the same structure:

1. Checkout.
2. Setup Bun.
3. Setup Rust with the platform target.
4. Install dependencies with `bun install --frozen-lockfile`.
5. Build workspace packages:
   - `@lume/shared`
   - `@lume/ui`
   - `@lume/sidecar`
   - `@lume/cli`
   - `@lume/web`
6. Prepare desktop bundle resources:
   - `bun scripts/build-natives-binary.mjs`
   - `bun scripts/build-sidecar-binary.mjs`
   - `bun scripts/build-default-skills-archive.mjs`
7. Verify package inputs.
8. Smoke test the compiled sidecar.
9. Run `tauri-apps/tauri-action@v0`.
10. Verify package artifacts.

Steps 6, 7, 8, 9, and 10 must set `TAURI_TARGET_TRIPLE` explicitly to the job target. The Tauri packaging step must also pass the matching `--target` for both macOS jobs and `--config src-tauri/tauri.release.conf.json` for every platform; Windows can use the host default plus `TAURI_TARGET_TRIPLE=x86_64-pc-windows-msvc`.

The `tauri-action` step must set these release inputs explicitly:

| Input | Required value |
|---|---|
| `GITHUB_TOKEN` env | `${{ secrets.RELEASE_TOKEN }}` |
| `releaseId` | `${{ needs.prepare-release.outputs.release_id }}` |
| `tagName` | `${{ github.ref_name }}` |
| `releaseDraft` | `true` |
| `prerelease` | `false` |
| `updaterJsonPreferNsis` | `true` |

`releaseId` is required so parallel platform jobs upload to the single draft created by `prepare-release` instead of racing to create or discover releases for the same tag. `releaseDraft: true` is still set defensively because auto-publish is owned only by the final `publish-release` job after all verification passes.

### 7.3 Remote Release Asset Verification

`verify-release-assets` should inspect the single draft release before publish:

- Use `GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}`.
- Read assets with `gh release view "${{ github.ref_name }}" --json assets,isDraft`.
- Fail if the release is missing or not draft.
- Fail if required remote assets are missing.
- Download `latest.json` and fail if it does not include updater entries for macOS ARM, macOS Intel, and Windows x64.
- Print the remote asset list to the GitHub job summary.

The remote asset verification should check for the same platform coverage as package artifact verification, but against uploaded release asset names:

| Platform | Required release asset coverage |
|---|---|
| macOS ARM | ARM `.dmg`, `.app.tar.gz`, and `.app.tar.gz.sig` assets, with asset names containing `aarch64` or `arm64` where Tauri emits architecture-specific names |
| macOS Intel | Intel `.dmg`, `.app.tar.gz`, and `.app.tar.gz.sig` assets, with asset names containing `x86_64` or `x64` where Tauri emits architecture-specific names |
| Windows x64 | NSIS installer and `.sig` |
| Updater | `latest.json` is present after all uploads |

The verifier should avoid hard-coding full versioned filenames. It should match extensions, architecture markers when present, and known Tauri bundle asset directories/names. For `latest.json`, it should parse JSON and verify platform coverage rather than only checking that the file exists.

### 7.4 Release Publishing

`publish-release` should:

- Check out the repository so `gh` has repository context.
- Use `GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}`.
- Run:

```bash
gh release edit "${{ github.ref_name }}" --draft=false
```

The workflow should not publish if any build job fails.

`publish-release` should also guard on tag refs:

```yaml
if: success() && startsWith(github.ref, 'refs/tags/v')
```

`tauri-action` is responsible only for building and uploading platform artifacts to the release id created by `prepare-release`. It must not be responsible for release creation. The publish job must only flip that single verified draft release to non-draft after all build jobs and remote asset verification complete.

Release notes are mandatory for auto-publish. If `docs/release/${{ github.ref_name }}.md` is missing, `prepare-release` should fail before any platform build starts.

## 7.5 Script Interfaces

| Script / Step | Inputs | Outputs | Failure mode | CI owner |
|---|---|---|---|---|
| `scripts/build-natives-binary.mjs` | `TAURI_TARGET_TRIPLE` or `--tauri-target` | `apps/desktop/src-tauri/binaries/lume-natives.node` | Non-zero exit if Cargo build or copy fails | Prepare resources |
| `scripts/build-sidecar-binary.mjs` | `TAURI_TARGET_TRIPLE` or `--tauri-target` | `apps/desktop/src-tauri/binaries/lume-sidecar-<target>` | Non-zero exit if target unsupported, compile fails, or output missing | Prepare resources |
| `scripts/build-default-skills-archive.mjs` | Repository root | `apps/desktop/src-tauri/resources/default-skills.tar` | Non-zero exit if archive cannot be written | Prepare resources |
| `scripts/verify-desktop-package-inputs.mjs` | `TAURI_TARGET_TRIPLE` | No files; validates package inputs | Non-zero exit naming missing/invalid contract item | Verify inputs |
| `scripts/smoke-compiled-sidecar.mjs` | `TAURI_TARGET_TRIPLE` | No files; validates compiled sidecar boot | Non-zero exit with stdout/stderr context | Smoke sidecar |
| `scripts/verify-desktop-package-artifacts.mjs` | `TAURI_TARGET_TRIPLE` | GitHub job summary artifact listing | Non-zero exit naming missing artifact pattern | Verify artifacts |
| `scripts/verify-release-assets.mjs` | `GH_TOKEN`, tag name | GitHub job summary remote asset listing | Non-zero exit naming missing remote asset coverage | Verify remote release |

## 8. Verification Gates

### 8.1 Package Input Verification

Add this verification script:

```text
scripts/verify-desktop-package-inputs.mjs
```

Inputs:

- `TAURI_TARGET_TRIPLE`
- repository root

Checks:

- Expected `lume-sidecar-<target>` exists.
- On macOS, sidecar file has executable permissions.
- `apps/desktop/src-tauri/binaries/lume-natives.node` exists.
- `apps/desktop/src-tauri/resources/default-skills.tar` exists.
- `tauri.conf.json` includes `externalBin: ["binaries/lume-sidecar"]`.
- Release resources do not include JS bridge artifacts as required release resources.

This gate runs before Tauri packaging and fails fast.

### 8.2 Compiled Sidecar Smoke Test

Add this smoke script:

```text
scripts/smoke-compiled-sidecar.mjs
```

The script should:

- Locate the compiled sidecar for `TAURI_TARGET_TRIPLE`.
- Set env similar to release startup:
  - `LUME_NATIVES_PATH`
  - `LUME_DEFAULT_SKILLS_ARCHIVE`
  - a temporary `LUME_CONFIG_DIR`
- Start the compiled sidecar.
- Send a minimal JSON-RPC `healthcheck` request over stdin using the same newline-delimited request framing as `apps/desktop/src-tauri/src/main.rs`.
- Require a successful response within a short timeout.
- Kill the process on timeout or failure.
- Print stderr/stdout context when failing.

This is the gate that catches compiled runtime failures such as dynamic data-file access problems.

### 8.3 Package Artifact Verification

Add a post-Tauri verification step, either inline per platform or as a script.

It should verify the platform produced expected artifacts under `apps/desktop/src-tauri/target/.../bundle`.

Minimum expectations:

- macOS jobs produce the app bundle, a distributable archive/image, and updater signature files.
- Windows job produces the NSIS installer and updater signature files.
- The step prints a concise artifact summary to the GitHub Actions job summary.

Artifact matrix:

| Platform job | Target directory | Required artifact patterns |
|---|---|---|
| `build-macos-arm` | `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle` | `macos/*.app`, `macos/*.app.tar.gz`, `macos/*.app.tar.gz.sig`, `dmg/*.dmg` |
| `build-macos-intel` | `apps/desktop/src-tauri/target/x86_64-apple-darwin/release/bundle` | `macos/*.app`, `macos/*.app.tar.gz`, `macos/*.app.tar.gz.sig`, `dmg/*.dmg` |
| `build-windows` | `apps/desktop/src-tauri/target/release/bundle` | `nsis/*.exe`, `nsis/*.exe.sig` |

If Tauri changes exact file names, the verifier should rely on these extensions and bundle subdirectories rather than hard-coded product-version strings.

This gate should not duplicate Tauri signing verification deeply, but it should catch missing output files before publish.

## 9. Failure Handling

- Any failed build, input verification, smoke test, Tauri packaging, or artifact verification blocks publishing.
- CI should leave the draft release and logs available for investigation.
- CI should not delete a failed draft automatically.
- The publish job should not rebuild or upload anything; it only publishes the single draft release created by `prepare-release` and verified by `verify-release-assets`.
- A release job should fail with messages that name the missing file, target triple, and expected contract.
- If a rerun finds the release already published, it should fail instead of editing a public release.
- If a rerun finds a draft release, `prepare-release` must delete stale assets before any platform upload job starts.

## 10. Documentation Updates

Update `docs/release/desktop-release.md` to match the new contract:

- Release sidecar is a standalone compiled Bun binary.
- Tauri packages it through `externalBin`.
- Release users do not need `node` or `bun`.
- CI auto-publishes only after macOS ARM, macOS Intel, and Windows x64 pass.
- CI creates exactly one draft release before platform builds and publishes only that verified draft.
- Linux is not currently in the release gate.

## 11. Implementation Boundaries

The implementation should stay focused on release packaging:

- Change workflow structure only where needed for the new contract.
- Update Tauri config and Rust startup only where needed to make release use external sidecar.
- Add targeted verification scripts rather than broad lint/test gates.
- Keep old JS bundle code only if needed for development, and make sure release does not rely on it.
- Avoid introducing new dependencies unless an existing runtime or standard library option is insufficient.

## 12. Acceptance Criteria

- CI has build jobs for macOS ARM, macOS Intel, and Windows x64.
- The release workflow triggers only from `v*` tag pushes.
- `prepare-release` is the only job that creates or reuses a GitHub draft release.
- `prepare-release` refreshes title/body and deletes stale draft assets on rerun.
- All release mutation uses `secrets.RELEASE_TOKEN` consistently.
- Platform jobs upload to `needs.prepare-release.outputs.release_id` and do not create releases.
- `verify-release-assets` checks the remote draft release before `publish-release`.
- macOS ARM smoke tests run on an arm64 macOS runner; macOS Intel smoke tests run on an Intel macOS runner.
- CI does not include Linux in the required release gate.
- Each platform job generates a compiled sidecar matching its Tauri target triple.
- Each platform job smoke-tests the compiled sidecar via `healthcheck`.
- Tauri config uses `externalBin` for `binaries/lume-sidecar`.
- The base Tauri config owns the `externalBin` contract; the release overlay only owns release-specific behavior such as updater artifacts.
- Release resources do not require JS bridge artifacts.
- Release startup does not rely on system `node` or system `bun`.
- `publish-release` automatically publishes only after all three build jobs and remote release asset verification pass.
- Remote asset verification requires macOS ARM and macOS Intel `.dmg`, `.app.tar.gz`, and `.app.tar.gz.sig` assets, Windows NSIS `.exe` and `.sig`, plus `latest.json` coverage for all three platforms.
- `docs/release/desktop-release.md` reflects the final release contract.

## 13. Risks

- `bun --compile` may still fail at runtime for dependencies that assume real filesystem data files. The compiled sidecar smoke test is mandatory because it turns this into a CI failure instead of a user-facing release failure.
- macOS Intel builds must run on `macos-15-intel` so the compiled sidecar smoke test executes on an Intel host. The job must keep `--target x86_64-apple-darwin` and verify the expected binary and Tauri output.
- Windows sidecar behavior must be validated without depending on Node path behavior. The standalone binary smoke test should run the `.exe` directly.
- Auto-publishing increases the cost of weak verification. The publish job is safe only if input, smoke, local artifact verification, and remote release asset verification are all required gates.
- Parallel artifact uploads can race if every platform job is allowed to create releases. The single `prepare-release` owner plus `releaseId` upload contract avoids release creation races.
- Draft reruns can publish stale assets if existing draft assets are left in place. `prepare-release` must clear draft assets before rebuilding.
