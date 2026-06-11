use std::io::Write;
use std::sync::Mutex;

use crate::config::LumeLoggerConfig;
use crate::event::LumeLogEvent;
use crate::level::LumeLogLevel;
use crate::redact;
use crate::writer::NdjsonWriter;

/// The global log backend. Implements `log::Log` so that existing
/// `info!`/`warn!`/`error!` calls automatically route through lume-logger.
#[derive(Debug)]
pub struct LumeLogBackend {
    config: LumeLoggerConfig,
    redact_patterns: Vec<String>,
    writer: Mutex<NdjsonWriter>,
}

impl LumeLogBackend {
    pub fn new(config: LumeLoggerConfig) -> Self {
        let logs_dir = crate::config::resolve_logs_dir();
        let redact_patterns = config.redact_keys.clone();
        let writer = NdjsonWriter::new(
            logs_dir,
            config.max_file_size_mb,
            config.retention_days,
        );
        Self {
            config,
            redact_patterns,
            writer: Mutex::new(writer),
        }
    }

    /// Emit a structured log event.
    pub fn emit_event(&self, mut event: LumeLogEvent) {
        let level = event.level;
        if level < self.config.level {
            return;
        }

        // Redact sensitive data
        if let Some(ref mut data) = event.data {
            redact::redact_value(data, &self.redact_patterns);
        }

        // Serialize to NDJSON
        let line = match serde_json::to_string(&event) {
            Ok(l) => l,
            Err(_) => return,
        };

        // Write to file
        if self.config.file_enabled {
            if let Ok(mut writer) = self.writer.lock() {
                writer.write_line(&line);
            }
        }

        // Write to console (stderr)
        if self.config.console_enabled {
            let _ = std::io::stderr().write_all(format!("{}\n", line).as_bytes());
        }
    }

    pub fn level(&self) -> LumeLogLevel {
        self.config.level
    }

    pub fn is_console_enabled(&self) -> bool {
        self.config.console_enabled
    }

    /// Flush pending file writes to disk.
    pub fn flush(&self) {
        if let Ok(mut writer) = self.writer.lock() {
            writer.flush();
        }
    }
}

impl log::Log for LumeLogBackend {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        let level: LumeLogLevel = metadata.level().into();
        level >= self.config.level
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let event = LumeLogEvent {
            ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            level: record.level().into(),
            source: "desktop".into(),
            context: record.target().to_string(),
            message: format!("{}", record.args()),
            data: None,
        };

        self.emit_event(event);
    }

    fn flush(&self) {
        if let Ok(mut writer) = self.writer.lock() {
            writer.flush();
        }
    }
}
