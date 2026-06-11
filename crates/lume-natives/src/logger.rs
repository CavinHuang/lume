//! N-API bindings for lume-logger.
//!
//! Exposes init_logger, emit_log, flush_logger, list_log_files, read_log_file
//! so that sidecar (via Bun) can use the unified Rust logger.
//!
//! Merged from `lume-logger-napi` crate into `lume-natives` to share a single .node binary.

use napi::bindgen_prelude::*;
use napi_derive::napi;

// ── Init ──────────────────────────────────────────────────

#[napi(object)]
pub struct JsLoggerConfig {
    pub level: Option<String>,
    pub file_enabled: Option<bool>,
    pub console_enabled: Option<bool>,
    pub retention_days: Option<u32>,
    pub max_file_size_mb: Option<u32>,
    pub redact_keys: Option<Vec<String>>,
}

/// Initialize the global lume-logger backend.
///
/// Can only be called once. Subsequent calls return an error.
#[napi]
pub fn init_logger(config: Option<JsLoggerConfig>) -> Result<()> {
    let js = config.unwrap_or(JsLoggerConfig {
        level: None,
        file_enabled: None,
        console_enabled: None,
        retention_days: None,
        max_file_size_mb: None,
        redact_keys: None,
    });

    let mut rust_config = lume_logger::LumeLoggerConfig::default();

    if let Some(ref level_str) = js.level {
        rust_config.level = level_str
            .parse()
            .map_err(|_| Error::from_reason(format!("invalid log level: {}", level_str)))?;
    }
    if let Some(v) = js.file_enabled {
        rust_config.file_enabled = v;
    }
    if let Some(v) = js.console_enabled {
        rust_config.console_enabled = v;
    }
    if let Some(v) = js.retention_days {
        rust_config.retention_days = v;
    }
    if let Some(v) = js.max_file_size_mb {
        rust_config.max_file_size_mb = v;
    }
    if let Some(ref keys) = js.redact_keys {
        rust_config.redact_keys = keys.clone();
    }

    lume_logger::init(rust_config)
        .map_err(|e| Error::from_reason(format!("logger init failed: {}", e)))
}

// ── Emit ──────────────────────────────────────────────────

#[napi(object)]
pub struct JsLogInput {
    pub level: String,
    pub source: Option<String>,
    pub context: String,
    pub message: String,
    pub data: Option<String>,
}

/// Emit a structured log event through the unified logger.
#[napi]
pub fn emit_log(input: JsLogInput) -> Result<()> {
    let level: lume_logger::LumeLogLevel = input
        .level
        .parse()
        .map_err(|_| Error::from_reason(format!("invalid log level: {}", input.level)))?;

    let data: Option<serde_json::Value> = input
        .data
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|e| Error::from_reason(format!("invalid data JSON: {}", e)))?;

    let event = lume_logger::LumeLogEvent {
        ts: chrono::Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        level,
        source: input.source.unwrap_or_else(|| "sidecar".into()),
        context: input.context,
        message: input.message,
        data,
    };

    lume_logger::emit_log_event(event);
    Ok(())
}

/// Flush pending log writes to disk.
///
/// Call this before process exit in runtimes (Bun) that may not
/// invoke Rust Drop on shutdown.
#[napi]
pub fn flush_logger() -> Result<()> {
    lume_logger::flush();
    Ok(())
}

// ── Reader ────────────────────────────────────────────────

#[napi(object)]
pub struct JsLogFileSummary {
    pub name: String,
    pub size_bytes: f64,
    pub modified_at: String,
}

#[napi(object)]
pub struct JsLogLineEntry {
    pub line_number: f64,
    pub level: String,
    pub text: String,
    pub raw_json: Option<String>,
}

#[napi(object)]
pub struct JsLogQuery {
    pub file_name: Option<String>,
    pub levels: Option<Vec<String>>,
    pub keyword: Option<String>,
    pub max_lines: Option<f64>,
}

/// List all .ndjson log files in the logs directory.
#[napi]
pub fn list_log_files() -> Result<Vec<JsLogFileSummary>> {
    let logs_dir = lume_logger::config::resolve_logs_dir();
    let files = lume_logger::list_log_files(&logs_dir);
    Ok(files
        .into_iter()
        .map(|f| JsLogFileSummary {
            name: f.name,
            size_bytes: f.size_bytes as f64,
            modified_at: f.modified_at,
        })
        .collect())
}

/// Read and parse a log file with optional filtering.
#[napi]
pub fn read_log_file(query: Option<JsLogQuery>) -> Result<Vec<JsLogLineEntry>> {
    let q = query.unwrap_or(JsLogQuery {
        file_name: None,
        levels: None,
        keyword: None,
        max_lines: None,
    });

    let levels: Option<Vec<lume_logger::LumeLogLevel>> = q
        .levels
        .map(|ls| {
            ls.iter()
                .map(|l| {
                    l.parse::<lume_logger::LumeLogLevel>()
                        .map_err(|e| Error::from_reason(format!("invalid level '{}': {}", l, e)))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;

    let rust_query = lume_logger::LogQuery {
        file_name: q.file_name,
        levels,
        keyword: q.keyword,
        max_lines: q.max_lines.map(|m| m as usize),
    };

    let logs_dir = lume_logger::config::resolve_logs_dir();
    let entries = lume_logger::read_log_file(&logs_dir, &rust_query);
    Ok(entries
        .into_iter()
        .map(|e| JsLogLineEntry {
            line_number: e.line_number as f64,
            level: e.level.to_string(),
            text: e.text,
            raw_json: e.raw_json,
        })
        .collect())
}
