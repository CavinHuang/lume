Lume node_repl Electron runtime resources.

This directory intentionally does not contain a Node executable.
The Rust host launches the packaged Electron executable with ELECTRON_RUN_AS_NODE=1.
Keep this directory outside app.asar (extraResources or asarUnpack).
