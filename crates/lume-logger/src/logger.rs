use serde::Serialize;

use crate::event::LumeLogEvent;
use crate::level::LumeLogLevel;

/// Create a logger builder for the given context.
///
/// # Example
/// ```no_run
/// lume_logger::logger("desktop.sidecar.rpc")
///     .field("request_id", "42")
///     .field("method", "agent.run")
///     .debug("request started");
/// ```
pub fn logger(context: impl Into<String>) -> LogBuilder {
    LogBuilder {
        context: context.into(),
        source: "desktop".into(),
        data: serde_json::Map::new(),
    }
}

/// Builder for structured log entries.
///
/// Call `.field()` to add data, then a level method (`.debug()`, `.info()`, etc.)
/// to emit the entry. The level method consumes `self`.
pub struct LogBuilder {
    context: String,
    source: String,
    data: serde_json::Map<String, serde_json::Value>,
}

impl LogBuilder {
    /// Add a structured field. Serializes any `Serialize` value.
    pub fn field(mut self, key: &str, value: impl Serialize) -> Self {
        self.data.insert(
            key.to_string(),
            serde_json::to_value(value).unwrap_or(serde_json::Value::Null),
        );
        self
    }

    /// Override the source (default: "desktop").
    pub fn source(mut self, source: impl Into<String>) -> Self {
        self.source = source.into();
        self
    }

    pub fn trace(self, msg: impl AsRef<str>) {
        self.emit(LumeLogLevel::Trace, msg.as_ref());
    }

    pub fn debug(self, msg: impl AsRef<str>) {
        self.emit(LumeLogLevel::Debug, msg.as_ref());
    }

    pub fn info(self, msg: impl AsRef<str>) {
        self.emit(LumeLogLevel::Info, msg.as_ref());
    }

    pub fn warn(self, msg: impl AsRef<str>) {
        self.emit(LumeLogLevel::Warn, msg.as_ref());
    }

    pub fn error(self, msg: impl AsRef<str>) {
        self.emit(LumeLogLevel::Error, msg.as_ref());
    }

    pub fn fatal(self, msg: impl AsRef<str>) {
        self.emit(LumeLogLevel::Fatal, msg.as_ref());
    }

    fn emit(self, level: LumeLogLevel, message: &str) {
        let data = if self.data.is_empty() {
            None
        } else {
            Some(serde_json::Value::Object(self.data))
        };

        let event = LumeLogEvent {
            ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            level,
            source: self.source,
            context: self.context,
            message: message.to_string(),
            data,
        };

        if let Some(backend) = crate::global_backend() {
            backend.emit_event(event);
        }
    }
}
