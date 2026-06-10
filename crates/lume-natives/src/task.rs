//! Blocking work scheduling for N-API exports.
//!
//! # Overview
//! Runs CPU-bound or blocking Rust work on libuv's thread pool via napi's
//! `Task` trait, with profiling and cancellation support.
//!
//! # Cancellation
//! Pass a `CancelToken` to blocking tasks. Work must check
//! `CancelToken::heartbeat()` periodically to respect cancellation.
//!
//! # Profiling
//! Samples are always collected into a circular buffer. Call
//! `get_work_profile()` to retrieve the last N seconds of data.
//!
//! # Usage
//! ```ignore
//! use crate::task::{blocking, CancelToken};
//!
//! #[napi]
//! fn my_heavy_work(signal: Option<AbortSignal>) -> AsyncTask<impl Task<...>> {
//!     let ct = CancelToken::new(None, signal);
//!     blocking("my_work", ct, |ct| {
//!         ct.heartbeat()?;
//!         // ... heavy computation ...
//!         Ok(result)
//!     })
//! }
//! ```
//!
//! License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use napi::{Env, Error, Result, Task, bindgen_prelude::*};
use tokio::sync::Notify;

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation (self-contained, adapted from pi_shell::cancel)
// ─────────────────────────────────────────────────────────────────────────────

/// Reason for task abortion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbortReason {
    Unknown,
    Timeout,
    Signal,
    User,
}

struct CancelState {
    aborted: AtomicBool,
    reason: std::sync::Mutex<Option<AbortReason>>,
    notify: Notify,
}

impl Default for CancelState {
    fn default() -> Self {
        Self {
            aborted: AtomicBool::new(false),
            reason: std::sync::Mutex::new(None),
            notify: Notify::new(),
        }
    }
}

/// Token for cooperative cancellation of blocking work.
///
/// Call `heartbeat()` periodically inside long-running work to check for
/// cancellation requests from timeouts or abort signals.
#[derive(Clone, Default)]
pub struct CancelToken {
    state: Arc<CancelState>,
    deadline: Option<Instant>,
}

impl From<()> for CancelToken {
    fn from((): ()) -> Self {
        Self::default()
    }
}

impl CancelToken {
    /// Create a new cancel token from optional timeout and abort signal.
    pub fn new(timeout_ms: Option<u32>, signal: Option<Unknown>) -> Self {
        let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms as u64));
        let mut result = Self {
            state: Arc::new(CancelState::default()),
            deadline,
        };
        if let Some(signal) = signal.and_then(|value| AbortSignal::from_unknown(value).ok()) {
            let abort_token = result.emplace_abort_token();
            signal.on_abort(move || abort_token.abort(AbortReason::Signal));
        }
        result
    }

    /// Create a cancel token with only a deadline (no JS abort signal).
    pub fn with_timeout(timeout_ms: u32) -> Self {
        Self {
            state: Arc::new(CancelState::default()),
            deadline: Some(Instant::now() + Duration::from_millis(timeout_ms as u64)),
        }
    }

    /// Check if cancellation has been requested.
    ///
    /// Returns `Ok(())` if work should continue, or an error if cancelled.
    /// Call this periodically in long-running loops.
    pub fn heartbeat(&self) -> Result<()> {
        // Check explicit abort first
        if self.state.aborted.load(Ordering::Relaxed) {
            let reason = self
                .state
                .reason
                .lock()
                .ok()
                .and_then(|r| *r)
                .unwrap_or(AbortReason::Unknown);
            return Err(Error::from_reason(format!(
                "Task cancelled: {:?}",
                reason
            )));
        }
        // Check deadline
        if let Some(deadline) = self.deadline {
            if Instant::now() >= deadline {
                self.do_abort(AbortReason::Timeout);
                return Err(Error::from_reason("Task cancelled: Timeout"));
            }
        }
        Ok(())
    }

    /// Wait for the cancel token to be aborted.
    pub async fn wait(&self) -> AbortReason {
        if self.state.aborted.load(Ordering::Relaxed) {
            return self
                .state
                .reason
                .lock()
                .ok()
                .and_then(|r| *r)
                .unwrap_or(AbortReason::Unknown);
        }
        // Use a tokio timeout so we don't block forever
        let notified = self.state.notify.notified();
        tokio::pin!(notified);
        loop {
            tokio::select! {
                _ = &mut notified => {
                    break;
                }
                _ = tokio::time::sleep(Duration::from_secs(3600)) => {
                    if self.state.aborted.load(Ordering::Relaxed) {
                        break;
                    }
                }
            }
        }
        self.state
            .reason
            .lock()
            .ok()
            .and_then(|r| *r)
            .unwrap_or(AbortReason::Unknown)
    }

    /// Get an abort token for external cancellation.
    pub fn abort_token(&self) -> AbortToken {
        AbortToken {
            state: Arc::clone(&self.state),
        }
    }

    /// Emplaces a cancel token if there is none, returns the abort token.
    pub fn emplace_abort_token(&mut self) -> AbortToken {
        AbortToken {
            state: Arc::clone(&self.state),
        }
    }

    /// Check if already aborted (non-blocking).
    pub fn aborted(&self) -> bool {
        self.state.aborted.load(Ordering::Relaxed)
    }

    fn do_abort(&self, reason: AbortReason) {
        self.state.aborted.store(true, Ordering::Relaxed);
        if let Ok(mut r) = self.state.reason.lock() {
            *r = Some(reason);
        }
        self.state.notify.notify_waiters();
    }
}

/// Token for requesting cancellation from outside the task.
#[derive(Clone, Default)]
pub struct AbortToken {
    state: Arc<CancelState>,
}

impl AbortToken {
    /// Request cancellation of the associated task.
    pub fn abort(&self, reason: AbortReason) {
        self.state.aborted.store(true, Ordering::Relaxed);
        if let Ok(mut r) = self.state.reason.lock() {
            *r = Some(reason);
        }
        self.state.notify.notify_waiters();
    }

    /// Check if already aborted (non-blocking).
    pub fn aborted(&self) -> bool {
        self.state.aborted.load(Ordering::Relaxed)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profiling stub (lightweight, no external deps)
// ─────────────────────────────────────────────────────────────────────────────

/// A guard that records wall-clock elapsed time on drop.
/// Currently a no-op placeholder — replace with real profiling later.
pub struct ProfileGuard {
    _tag: &'static str,
    _start: Instant,
}

impl Drop for ProfileGuard {
    fn drop(&mut self) {
        // In the future: record self._start.elapsed() into a shared profile buffer.
    }
}

/// Create a profile guard for the given tag.
pub fn profile_region(tag: &'static str) -> ProfileGuard {
    ProfileGuard {
        _tag: tag,
        _start: Instant::now(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocking Task - libuv thread pool integration
// ─────────────────────────────────────────────────────────────────────────────

/// Task that runs blocking work on libuv's thread pool with profiling.
///
/// This implements napi's `Task` trait, running `compute()` on a libuv worker
/// thread and `resolve()` on the main JS thread.
pub struct Blocking<T>
where
    T: Send + 'static,
{
    tag:          &'static str,
    cancel_token: CancelToken,
    work:         Option<Box<dyn FnOnce(CancelToken) -> Result<T> + Send>>,
}

impl<T> Task for Blocking<T>
where
    T: ToNapiValue + Send + 'static + TypeName,
{
    type JsValue = T;
    type Output = T;

    fn compute(&mut self) -> Result<Self::Output> {
        let _guard = profile_region(self.tag);
        let work = self
            .work
            .take()
            .ok_or_else(|| Error::from_reason("BlockingTask: work already consumed"))?;
        work(self.cancel_token.clone())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub type Promise<T> = AsyncTask<Blocking<T>>;

/// Create an `AsyncTask` that runs blocking work on libuv's thread pool.
///
/// Returns `AsyncTask<BlockingTask<T>>` which can be returned directly from
/// `#[napi]` functions — it becomes `Promise<T>` on the JS side.
///
/// # Arguments
/// - `tag`: Profiling tag for this work (appears in flamegraphs)
/// - `cancel_token`: Token for cooperative cancellation
/// - `work`: Closure that performs the blocking work
///
/// # Example
/// ```ignore
/// #[napi]
/// fn heavy_computation(signal: Option<AbortSignal>) -> AsyncTask<impl Task<...>> {
///     let ct = CancelToken::new(None, signal);
///     blocking("heavy_computation", ct, |ct| {
///         for i in 0..1000 {
///             ct.heartbeat()?; // Check for cancellation
///             // ... do work ...
///         }
///         Ok(result)
///     })
/// }
/// ```
pub fn blocking<T, F>(
    tag: &'static str,
    cancel_token: impl Into<CancelToken>,
    work: F,
) -> AsyncTask<Blocking<T>>
where
    F: FnOnce(CancelToken) -> Result<T> + Send + 'static,
    T: ToNapiValue + TypeName + Send + 'static,
{
    AsyncTask::new(Blocking {
        tag,
        cancel_token: cancel_token.into(),
        work: Some(Box::new(work)),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Task - Tokio runtime integration
// ─────────────────────────────────────────────────────────────────────────────

/// Run an async task on Tokio's runtime with profiling.
///
/// Use this for operations that need to `.await` (async I/O, `select!`, etc.).
/// For CPU-bound blocking work, use [`blocking`] instead.
///
/// # Arguments
/// - `env`: N-API environment (needed for `spawn_future`)
/// - `tag`: Profiling tag for this work
/// - `work`: Async closure that performs the work
///
/// # Example
/// ```ignore
/// #[napi]
/// fn run_async_io<'e>(env: &'e Env) -> Result<PromiseRaw<'e, String>> {
///     future(env, "async_io", async move {
///         let data = fetch_data().await?;
///         Ok(data)
///     })
/// }
/// ```
pub fn future<'env, T, Fut>(
    env: &'env Env,
    tag: &'static str,
    work: Fut,
) -> Result<PromiseRaw<'env, T>>
where
    Fut: Future<Output = Result<T>> + Send + 'static,
    T: ToNapiValue + Send + 'static,
{
    env.spawn_future(async move {
        let _guard = profile_region(tag);
        work.await
    })
}
