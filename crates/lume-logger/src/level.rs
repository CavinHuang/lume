use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// Unified log level for all Lume components.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum LumeLogLevel {
    Trace = 0,
    Debug = 1,
    Info = 2,
    Warn = 3,
    Error = 4,
    Fatal = 5,
}

impl LumeLogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "trace",
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
            Self::Fatal => "fatal",
        }
    }
}

impl Default for LumeLogLevel {
    fn default() -> Self {
        Self::Info
    }
}

impl fmt::Display for LumeLogLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for LumeLogLevel {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "trace" => Ok(Self::Trace),
            "debug" => Ok(Self::Debug),
            "info" => Ok(Self::Info),
            "warn" => Ok(Self::Warn),
            "error" => Ok(Self::Error),
            "fatal" => Ok(Self::Fatal),
            _ => Err(format!("unknown log level: {s}")),
        }
    }
}

impl From<log::Level> for LumeLogLevel {
    fn from(level: log::Level) -> Self {
        match level {
            log::Level::Trace => Self::Trace,
            log::Level::Debug => Self::Debug,
            log::Level::Info => Self::Info,
            log::Level::Warn => Self::Warn,
            log::Level::Error => Self::Error,
        }
    }
}

impl From<LumeLogLevel> for log::Level {
    fn from(level: LumeLogLevel) -> Self {
        match level {
            LumeLogLevel::Trace => log::Level::Trace,
            LumeLogLevel::Debug => log::Level::Debug,
            LumeLogLevel::Info => log::Level::Info,
            LumeLogLevel::Warn => log::Level::Warn,
            LumeLogLevel::Error | LumeLogLevel::Fatal => log::Level::Error,
        }
    }
}

impl LumeLogLevel {
    /// Convert to `log::LevelFilter`.
    pub fn to_level_filter(self) -> log::LevelFilter {
        match self {
            Self::Trace => log::LevelFilter::Trace,
            Self::Debug => log::LevelFilter::Debug,
            Self::Info => log::LevelFilter::Info,
            Self::Warn => log::LevelFilter::Warn,
            Self::Error => log::LevelFilter::Error,
            // Fatal maps to Error — there's no Fatal in the log crate.
            Self::Fatal => log::LevelFilter::Error,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_str() {
        for level in [
            LumeLogLevel::Trace,
            LumeLogLevel::Debug,
            LumeLogLevel::Info,
            LumeLogLevel::Warn,
            LumeLogLevel::Error,
            LumeLogLevel::Fatal,
        ] {
            assert_eq!(level.as_str().parse::<LumeLogLevel>().unwrap(), level);
        }
    }

    #[test]
    fn from_log_level() {
        assert_eq!(LumeLogLevel::from(log::Level::Info), LumeLogLevel::Info);
        assert_eq!(log::Level::from(LumeLogLevel::Fatal), log::Level::Error);
    }

    #[test]
    fn ordering() {
        assert!(LumeLogLevel::Trace < LumeLogLevel::Info);
        assert!(LumeLogLevel::Error < LumeLogLevel::Fatal);
    }
}
