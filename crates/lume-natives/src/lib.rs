//! Lume native performance primitives.
//!
//! N-API bindings for token counting, file search, glob, and more.
//! Sourced from oh-my-pi (pi-natives) with adaptations.
//!
//! License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük

pub mod tokens;
pub mod utils;

// Phase 2 modules (uncomment to enable)
pub mod task;
pub mod fs_cache;
pub mod glob_util;
pub mod grep;
pub mod glob;
pub mod fd;
pub mod ast;
