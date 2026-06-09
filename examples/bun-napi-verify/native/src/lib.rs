//! Bun + napi-rs 兼容性验证
//!
//! 验证点：
//! 1. 基础函数调用 + 字符串返回
//! 2. 结构化对象入参（模拟 logger 的 JsLogInput）
//! 3. Result 返回（成功 / 错误）
//! 4. 异步函数
//! 5. 高频调用性能（logger 场景下每秒可能数百次）
//! 6. 全局状态（模拟 logger 初始化后持有多写器）

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

// ── 1. 基础函数 ──────────────────────────────────────────

#[napi]
pub fn hello() -> String {
    "hello from napi".to_string()
}

// ── 2. 结构化对象入参 ────────────────────────────────────

#[napi(object)]
pub struct LogInput {
    pub level: String,
    pub source: String,
    pub context: String,
    pub message: String,
    pub data: Option<String>,
}

#[napi(object)]
pub struct LogResult {
    pub written: bool,
    pub bytes: u32,
}

/// 模拟 logger 核心写入：接收结构化输入，返回写入结果
#[napi]
pub fn emit_log(input: LogInput) -> LogResult {
    let json = serde_json::json!({
        "level": input.level,
        "source": input.source,
        "context": input.context,
        "message": input.message,
        "data": input.data,
    });
    let bytes = json.to_string().len() as u32;
    LogResult {
        written: true,
        bytes,
    }
}

// ── 3. Result 返回 ──────────────────────────────────────

#[napi]
pub fn init_logger(config_dir: String) -> Result<()> {
    if config_dir.is_empty() {
        return Err(Error::from_reason("config_dir cannot be empty"));
    }
    // 模拟初始化成功
    Ok(())
}

// ── 4. 异步函数 ─────────────────────────────────────────

/// 模拟文件写入（异步）
#[napi]
pub async fn async_write_log(message: String) -> Result<String> {
    // 模拟一次 fs write 的延迟
    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    Ok(format!("written: {}", message))
}

// ── 5. 高频调用 ─────────────────────────────────────────

static CALL_COUNT: AtomicU64 = AtomicU64::new(0);

#[napi]
pub fn ping() -> u64 {
    CALL_COUNT.fetch_add(1, Ordering::Relaxed)
}

/// 批量写入：验证一次性传递多条日志的吞吐
#[napi]
pub fn emit_batch(inputs: Vec<LogInput>) -> u32 {
    inputs.len() as u32
}

// ── 6. 全局状态 ─────────────────────────────────────────

static GLOBAL_LOGGER: Mutex<Option<String>> = Mutex::new(None);

#[napi]
pub fn setup_global_logger(log_dir: String) -> Result<()> {
    let mut guard = GLOBAL_LOGGER
        .lock()
        .map_err(|e| Error::from_reason(format!("lock failed: {}", e)))?;
    *guard = Some(log_dir);
    Ok(())
}

#[napi]
pub fn get_log_dir() -> Result<String> {
    let guard = GLOBAL_LOGGER
        .lock()
        .map_err(|e| Error::from_reason(format!("lock failed: {}", e)))?;
    guard
        .clone()
        .ok_or_else(|| Error::from_reason("logger not initialized"))
}
