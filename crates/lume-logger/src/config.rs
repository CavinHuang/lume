use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::level::LumeLogLevel;

/// Built-in sensitive key patterns for redaction.
const DEFAULT_REDACT_KEYS: &[&str] = &[
    "token",
    "secret",
    "password",
    "apikey",
    "authorization",
    "cookie",
    "set-cookie",
    "accesstoken",
    "refreshtoken",
];

/// Configuration for lume-logger.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LumeLoggerConfig {
    pub level: LumeLogLevel,
    pub file_enabled: bool,
    pub console_enabled: bool,
    pub retention_days: u32,
    pub max_file_size_mb: u32,
    pub redact_keys: Vec<String>,
}

impl Default for LumeLoggerConfig {
    fn default() -> Self {
        Self {
            level: LumeLogLevel::Info,
            file_enabled: true,
            console_enabled: false,
            retention_days: 14,
            max_file_size_mb: 20,
            redact_keys: DEFAULT_REDACT_KEYS.iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// Resolve the Lume config directory (`~/.lume`), honoring `LUME_CONFIG_DIR`.
/// Mirrors `resolve_logs_dir` minus the `logs` join.
pub fn resolve_config_dir() -> PathBuf {
    if let Some(config_dir) = current_config_dir_from_env() {
        return config_dir;
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".lume");
    }
    PathBuf::from(".lume")
}

/// Resolve the log directory.
///
/// Priority: `LUME_CONFIG_DIR/logs` → `~/.lume/logs` → `.lume/logs`
///
/// Extracted from desktop's `main.rs:resolve_logs_dir()`.
pub fn resolve_logs_dir() -> PathBuf {
    if let Some(config_dir) = current_config_dir_from_env() {
        return config_dir.join("logs");
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".lume").join("logs");
    }
    PathBuf::from(".lume").join("logs")
}

fn current_config_dir_from_env() -> Option<PathBuf> {
    let val = std::env::var("LUME_CONFIG_DIR").ok()?;
    let trimmed = val.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    Some(if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config() {
        let config = LumeLoggerConfig::default();
        assert_eq!(config.level, LumeLogLevel::Info);
        assert!(config.file_enabled);
        assert!(!config.console_enabled);
        assert_eq!(config.retention_days, 14);
        assert!(!config.redact_keys.is_empty());
    }

    #[test]
    fn resolve_config_dir_uses_env() {
        std::env::set_var("LUME_CONFIG_DIR", "/tmp/lume-config-dir-test");
        let dir = resolve_config_dir();
        assert_eq!(dir, PathBuf::from("/tmp/lume-config-dir-test"));
        std::env::remove_var("LUME_CONFIG_DIR");
    }
}
