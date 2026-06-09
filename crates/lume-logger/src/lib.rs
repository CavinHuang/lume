pub mod backend;
pub mod config;
pub mod event;
pub mod level;
pub mod logger;
pub mod reader;
pub mod redact;
pub mod writer;

// Re-exports
pub use config::LumeLoggerConfig;
pub use level::LumeLogLevel;
pub use logger::{logger, LogBuilder};
pub use reader::{list_log_files, read_log_file, LogFileSummary, LogLineEntry, LogQuery};

use std::sync::OnceLock;

use backend::LumeLogBackend;

/// Global backend instance. Shared by both the `log::Log` bridge and the builder API.
static BACKEND: OnceLock<LumeLogBackend> = OnceLock::new();

/// Get a reference to the global backend (used by `LogBuilder`).
pub(crate) fn global_backend() -> Option<&'static LumeLogBackend> {
    BACKEND.get()
}

/// Thin wrapper that implements `log::Log` by delegating to the global `LumeLogBackend`.
struct LogBridge;

impl log::Log for LogBridge {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        BACKEND.get().map_or(false, |b| b.enabled(metadata))
    }

    fn log(&self, record: &log::Record) {
        if let Some(b) = BACKEND.get() {
            b.log(record);
        }
    }

    fn flush(&self) {
        if let Some(b) = BACKEND.get() {
            b.flush();
        }
    }
}

/// Initialize lume-logger as the global log backend.
///
/// Must be called once at startup, before any `info!`/`warn!`/`error!` calls.
/// Replaces tauri-plugin-log (or any other log backend).
pub fn init(config: LumeLoggerConfig) -> Result<(), log::SetLoggerError> {
    let max_level = config.level.to_level_filter();
    let backend = LumeLogBackend::new(config);

    // Store backend in the global OnceLock first.
    BACKEND
        .set(backend)
        .expect("lume_logger::init called more than once");

    // Register LogBridge as the global log handler.
    log::set_boxed_logger(Box::new(LogBridge))?;
    log::set_max_level(max_level);
    Ok(())
}
