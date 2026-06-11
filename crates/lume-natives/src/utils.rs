//! Utility macros and functions.
//! Adapted from oh-my-pi pi-natives/src/utils.rs
//! License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük

/// Read a compile-time env var as u32, with optional clamp range.
#[macro_export]
macro_rules! env_uint {
    ($name:ident, $default:expr) => {
        static $name: u32 = {
            let val = option_env!(stringify!($name))
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or($default);
            val
        };
    };
    ($name:ident, $default:expr, clamp $min:expr => $max:expr) => {
        static $name: u32 = {
            let val = option_env!(stringify!($name))
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or($default);
            let clamped = val.clamp($min, $max);
            clamped
        };
    };
}

/// Saturating cast u64 → u32.
#[inline]
pub fn clamp_u32(v: u64) -> u32 {
    if v > u32::MAX as u64 {
        u32::MAX
    } else {
        v as u32
    }
}
