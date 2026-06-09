use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::level::LumeLogLevel;

/// Metadata for a single log file.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileSummary {
    pub name: String,
    pub size_bytes: u64,
    pub modified_at: String,
}

/// A parsed log line ready for display.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLineEntry {
    pub line_number: usize,
    pub level: LumeLogLevel,
    pub text: String,
    /// Raw NDJSON line for "copy JSON" functionality.
    pub raw_json: Option<String>,
}

/// Query parameters for reading log files.
pub struct LogQuery {
    pub file_name: Option<String>,
    pub levels: Option<Vec<LumeLogLevel>>,
    pub keyword: Option<String>,
    pub max_lines: Option<usize>,
}

impl Default for LogQuery {
    fn default() -> Self {
        Self {
            file_name: None,
            levels: None,
            keyword: None,
            max_lines: Some(5000),
        }
    }
}

/// List all `.ndjson` log files in the logs directory.
pub fn list_log_files(logs_dir: &Path) -> Vec<LogFileSummary> {
    let Ok(entries) = fs::read_dir(logs_dir) else {
        return vec![];
    };

    let mut files: Vec<LogFileSummary> = entries
        .flatten()
        .filter(|e| {
            let name = e.file_name();
            let name_str = name.to_string_lossy();
            name_str.starts_with("lume-") && name_str.ends_with(".ndjson")
        })
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let name = e.file_name().to_string_lossy().into_owned();
            let modified = meta.modified().ok()?;
            let modified_at = modified
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as i64;
            Some(LogFileSummary {
                name,
                size_bytes: meta.len(),
                modified_at: chrono::DateTime::from_timestamp_millis(modified_at)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default(),
            })
        })
        .collect();

    // Sort by name descending (newest first)
    files.sort_by(|a, b| b.name.cmp(&a.name));
    files
}

/// Read and parse an NDJSON log file with optional filtering.
pub fn read_log_file(logs_dir: &Path, query: &LogQuery) -> Vec<LogLineEntry> {
    let file_name = match &query.file_name {
        Some(name) => name.clone(),
        None => return vec![],
    };

    // Safety: reject path traversal
    if file_name.contains("..") || file_name.contains('/') || file_name.contains('\\') {
        return vec![];
    }

    let path = logs_dir.join(&file_name);
    let Ok(file) = fs::File::open(&path) else {
        return vec![];
    };

    let max_lines = query.max_lines.unwrap_or(5000);
    let allowed_levels: Option<std::collections::HashSet<LumeLogLevel>> = query
        .levels
        .as_ref()
        .map(|levels| levels.iter().cloned().collect());
    let keyword = query.keyword.as_deref().map(|k| k.to_lowercase());

    let reader = BufReader::new(file);
    let mut entries = Vec::new();

    for (idx, line_result) in reader.lines().enumerate() {
        let Ok(raw) = line_result else {
            break;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }

        let parsed = parse_ndjson_line(trimmed);

        // Level filter
        if let Some(ref levels) = allowed_levels {
            if !levels.contains(&parsed.level) {
                continue;
            }
        }

        // Keyword filter
        if let Some(ref kw) = keyword {
            if !parsed.text.to_lowercase().contains(kw.as_str()) {
                continue;
            }
        }

        entries.push(LogLineEntry {
            line_number: idx + 1,
            level: parsed.level,
            text: parsed.text,
            raw_json: Some(trimmed.to_string()),
        });

        if entries.len() >= max_lines {
            break;
        }
    }

    entries
}

struct ParsedLine {
    level: LumeLogLevel,
    text: String,
}

fn parse_ndjson_line(raw: &str) -> ParsedLine {
    // Try parsing as NDJSON from lume-logger
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(obj) = val.as_object() {
            // lume-logger NDJSON has `level` as a string
            if let Some(level_str) = obj.get("level").and_then(|v| v.as_str()) {
                if let Ok(level) = level_str.parse::<LumeLogLevel>() {
                    let ts = obj.get("ts").and_then(|v| v.as_str()).unwrap_or("");
                    let source = obj.get("source").and_then(|v| v.as_str()).unwrap_or("");
                    let context = obj.get("context").and_then(|v| v.as_str()).unwrap_or("");
                    let message = obj.get("message").and_then(|v| v.as_str()).unwrap_or("");

                    let time_short = ts
                        .get(..19)
                        .unwrap_or(ts)
                        .replace('T', " ");

                    let level_tag = format_level_tag(level);
                    let data_suffix = format_data_suffix(obj);

                    return ParsedLine {
                        level,
                        text: format!(
                            "{time_short}  {level_tag}  {source}/{context}  {message}{data_suffix}"
                        ),
                    };
                }
            }
        }
    }

    // Fallback: treat as plain text
    ParsedLine {
        level: infer_level(raw),
        text: raw.to_string(),
    }
}

fn format_level_tag(level: LumeLogLevel) -> &'static str {
    match level {
        LumeLogLevel::Trace => "TRACE",
        LumeLogLevel::Debug => "DEBUG",
        LumeLogLevel::Info => "INFO ",
        LumeLogLevel::Warn => "WARN ",
        LumeLogLevel::Error => "ERROR",
        LumeLogLevel::Fatal => "FATAL",
    }
}

fn format_data_suffix(obj: &serde_json::Map<String, serde_json::Value>) -> String {
    let skip_keys = ["ts", "level", "source", "context", "message"];
    let data: serde_json::Map<String, serde_json::Value> = obj
        .iter()
        .filter(|(k, _)| !skip_keys.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if data.is_empty() {
        String::new()
    } else {
        format!(" {}", serde_json::Value::Object(data))
    }
}

fn infer_level(raw: &str) -> LumeLogLevel {
    let lower = raw.to_lowercase();
    if lower.contains("fatal") {
        LumeLogLevel::Fatal
    } else if lower.contains("error") {
        LumeLogLevel::Error
    } else if lower.contains("warn") {
        LumeLogLevel::Warn
    } else if lower.contains("debug") {
        LumeLogLevel::Debug
    } else if lower.contains("trace") {
        LumeLogLevel::Trace
    } else {
        LumeLogLevel::Info
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ndjson_line_basic() {
        let raw = r#"{"ts":"2026-06-09T08:00:00.000Z","level":"info","source":"desktop","context":"desktop.app.boot","message":"desktop started"}"#;
        let parsed = parse_ndjson_line(raw);
        assert_eq!(parsed.level, LumeLogLevel::Info);
        assert!(parsed.text.contains("desktop started"));
        assert!(parsed.text.contains("INFO"));
    }

    #[test]
    fn parse_ndjson_line_with_data() {
        let raw = r#"{"ts":"2026-06-09T08:00:01.120Z","level":"debug","source":"desktop","context":"desktop.sidecar.rpc","message":"request started","data":{"request_id":"42","method":"agent.run"}}"#;
        let parsed = parse_ndjson_line(raw);
        assert_eq!(parsed.level, LumeLogLevel::Debug);
        assert!(parsed.text.contains("request_id"));
    }

    #[test]
    fn fallback_plain_text() {
        let raw = "some plain text log line";
        let parsed = parse_ndjson_line(raw);
        assert_eq!(parsed.level, LumeLogLevel::Info);
        assert_eq!(parsed.text, "some plain text log line");
    }
}
