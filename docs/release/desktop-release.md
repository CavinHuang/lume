# Desktop Release

Lume desktop releases are packaged with Electron 42.5.1 and Electron Builder, distributed through GitHub Releases, and checked in-app through Electron update metadata plus GitHub release metadata.

## Required Secrets And Variables

- `RELEASE_TOKEN`: GitHub token used by the release workflow to create draft releases, upload assets, delete stale assets on reruns, verify remote assets, and publish.
- `GH_TOKEN`: set by workflow steps from `RELEASE_TOKEN` for GitHub CLI commands.
- `LUME_DESKTOP_TARGET`: optional local target override for artifact verification scripts. Supported release values are `aarch64-apple-darwin`, `x86_64-apple-darwin`, and `x86_64-pc-windows-msvc`.

## Release Flow

1. Update versions in root `package.json` and `apps/desktop/package.json`.
2. Create and push a tag such as `v0.1.1`.
3. GitHub Actions creates or reuses one draft release for the tag and clears stale assets before rebuilding.
4. GitHub Actions builds shared packages, the sidecar, and the web app once, then reuses those JS assets for desktop packaging.
5. Each desktop package job builds the Rust N-API native module for its runner architecture into `apps/desktop/resources/natives/<platform>-<arch>/lume-natives.node`.
6. Each desktop package job builds the TypeScript main process and sandbox preload with Vite into `apps/desktop/dist`, builds the sidecar and default-skills resources, verifies package inputs, smokes the sidecar through an Electron utility process, and packages with Electron Builder.
7. The macOS package job builds both x64 and ARM64 native modules and both Electron architectures in the same Electron Builder invocation so `latest-mac.yml` covers both updater targets.
8. The workflow uploads macOS and Windows Electron artifacts from `apps/desktop/dist-release` to the shared draft release.
9. A final remote gate verifies both macOS architectures in `latest-mac.yml` plus the Windows installer and updater assets, then publishes the draft automatically only after all gates pass.

## Local Commands

- `bun run build:desktop`: build shared packages, sidecar, web assets, and an unpacked Electron desktop directory.
- `bun run package:desktop`: build shared packages, sidecar, web assets, and a local Electron installer/package.
- `bun run release:desktop`: local release packaging entrypoint; currently delegates to `package:desktop`.
- `bun scripts/build-natives-binary.mjs`: build the current platform Rust N-API module into Electron resources.
- `bun scripts/build-sidecar-bundle.mjs`: bundle the sidecar entrypoint as desktop resource JavaScript.
- `bun run --filter @lume/desktop build:runtime`: build the Electron TypeScript main process and preload with Vite.
- `bun scripts/verify-desktop-package-inputs.mjs`: verify Electron package inputs before packaging.
- `bun scripts/smoke-sidecar-bundle.mjs`: run the sidecar bundle with Electron `utilityProcess` and call `healthcheck` over its parent port.
- `LUME_DESKTOP_TARGET=<target> bun scripts/verify-desktop-package-artifacts.mjs`: verify local Electron Builder outputs after packaging.

## Bundled Sidecar

Release builds bundle `apps/sidecar/src/index.ts` into `apps/desktop/resources/sidecar/index.mjs` before Electron packaging. Electron Builder copies the whole `apps/desktop/resources/sidecar` directory into the installed app resources.

Rust native functionality is distributed only as `.node` dynamic libraries under `resources/natives`. Packaged builds pass the selected binary through `LUME_NATIVES_PATH`; the renderer never receives that path and cannot call native modules directly. The sidecar does not report ready until the native module loads and exposes the required capabilities.

At runtime, packaged builds start the sidecar bundle with Electron `utilityProcess.fork` and exchange JSON-RPC payloads over the utility parent port. The sidecar keeps its newline-delimited stdio transport for development tools, while the packaged desktop requires no system Node, system Bun, source paths, Tauri, standalone sidecar executable, or any non-Electron desktop runtime.
