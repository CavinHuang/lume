# Lume Release and Auto Update

This document describes the first-stage packaging and whole-app update flow for Lume.

## Scope

The current implementation focuses on whole-app updates only.

- GitHub Actions validates PRs and pushes.
- Tagged releases build desktop installers for macOS, Windows and Linux.
- Tauri creates updater artifacts and `latest.json`.
- The web settings page can check, download, install and restart through the Tauri updater plugin.

No hot update or remote code replacement is included.

## Required secrets

At minimum, configure these repository secrets before publishing update-enabled releases:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

For public macOS distribution, also configure:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

For public Windows distribution, also configure:

- `WINDOWS_CERTIFICATE`
- `WINDOWS_CERTIFICATE_PASSWORD`

## Updater public key

`apps/desktop/src-tauri/tauri.conf.json` currently contains a placeholder updater public key:

```json
"pubkey": "REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY"
```

Generate a Tauri updater key pair and replace this value before producing a real release build.

The corresponding private key must be stored in `TAURI_SIGNING_PRIVATE_KEY`.

## Release flow

1. Ensure `tauri.conf.json` contains the real updater public key.
2. Push a version tag, for example:

```bash
git tag v0.1.0
git push origin v0.1.0
```

3. The release workflow builds packages and creates a draft GitHub Release.
4. Verify the draft artifacts, installer behavior and `latest.json`.
5. Publish the release manually.

## Sidecar packaging

The release workflow runs:

```bash
bun run release:prepare
```

This compiles the sidecar into the Tauri external binary directory:

```text
apps/desktop/src-tauri/binaries/lume-sidecar-<target-triple>
```

The Tauri bundle includes this binary via `externalBin`.

## Remaining implementation note

The Rust desktop bootstrap must register the updater and process plugins in `main.rs`:

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```

This registration is required for the frontend updater service to work in a packaged Tauri runtime.
