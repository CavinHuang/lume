use std::{
    collections::{HashMap, HashSet},
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, Mutex},
    time::{sleep_until, Instant},
};
use uuid::Uuid;

use crate::{
    cli::parse_bool_env,
    host::HostServices,
    protocol::{ExecutionImage, ExecutionResult, RuntimeManifest},
};

#[async_trait]
pub trait Elicitor: Send + Sync {
    async fn elicit(&self, message: &str, requested_schema: Value, meta: Value) -> Result<Value>;
}

#[async_trait]
pub trait HostCallHandler: Send + Sync {
    async fn call(&self, id: String, exec_id: String, method: String, args: Value) -> Result<Value>;
}

#[derive(Debug, Clone)]
pub struct RuntimeOptions {
    pub cwd: PathBuf,
    pub node_path: PathBuf,
    pub kernel_path: PathBuf,
    pub codex_cli_path: Option<PathBuf>,
    pub disable_sandbox: bool,
    pub sandbox_allowed_unix_sockets: Vec<PathBuf>,
    pub session_id: String,
    pub default_timeout: Duration,
    pub minimum_node_version: (u64, u64, u64),
    pub response_meta_trace: bool,
    pub module_dirs: Vec<PathBuf>,
    pub trusted_code_paths: Vec<PathBuf>,
    pub trusted_source_hashes: Vec<String>,
    pub trust_all_imported_code: bool,
    pub untrusted_env_allowlist: Vec<String>,
    pub disable_analytics: bool,
    pub disable_ambient_network: bool,
    pub manifest: RuntimeManifest,
    pub artifact_directory: PathBuf,
    pub codex_home: PathBuf,
    pub config_file: PathBuf,
    pub native_pipe_connect_timeout: Duration,
    #[cfg(unix)]
    pub native_pipe_allowed_roots: Vec<PathBuf>,
    pub max_native_pipe_connections: usize,
    pub active_exec_registry_dir: Option<PathBuf>,
}

impl RuntimeOptions {
    pub fn from_environment(
        cwd_override: Option<PathBuf>,
        node_override: Option<PathBuf>,
        kernel_override: Option<PathBuf>,
        disable_sandbox: bool,
    ) -> Result<Self> {
        let cwd = cwd_override.unwrap_or(env::current_dir().context("resolve current directory")?);
        let node_path = node_override
            .or_else(|| env::var_os("NODE_REPL_NODE_PATH").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" }));
        let kernel_path = match kernel_override
            .or_else(|| env::var_os("NODE_REPL_KERNEL_PATH").map(PathBuf::from))
        {
            Some(path) => path,
            None => resolve_kernel_path()?,
        };
        let codex_home = env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
            .unwrap_or_else(|| cwd.join(".lume-cua").join("codex-home"));
        let artifact_directory = env::var_os("NODE_REPL_ARTIFACT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| env::temp_dir().join("node_repl").join("artifacts"));
        let mut manifest = env::var("LUME_CUA_RUNTIME_MANIFEST")
            .ok()
            .and_then(|text| serde_json::from_str::<RuntimeManifest>(&text).ok())
            .unwrap_or_default();
        if manifest.name.trim().is_empty() {
            manifest.name = "node_repl".to_string();
        }
        for origin in split_loose(env::var("NODE_REPL_ALLOWED_FETCH_ORIGINS").ok()) {
            if !manifest.allowed_fetch_origins.contains(&origin) {
                manifest.allowed_fetch_origins.push(origin);
            }
        }
        let minimum_node_version = parse_version_tuple(
            &env::var("NODE_REPL_MINIMUM_NODE_VERSION").unwrap_or_else(|_| "22.22.0".to_string()),
        )?;
        Ok(Self {
            cwd,
            node_path,
            kernel_path,
            codex_cli_path: env::var_os("CODEX_CLI_PATH").map(PathBuf::from),
            disable_sandbox,
            sandbox_allowed_unix_sockets: split_paths(env::var_os(
                "NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS",
            )),
            session_id: env::var("NODE_REPL_SESSION_ID")
                .unwrap_or_else(|_| Uuid::new_v4().to_string()),
            default_timeout: Duration::from_millis(
                env::var("NODE_REPL_DEFAULT_TIMEOUT_MS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(30_000),
            ),
            minimum_node_version,
            response_meta_trace: parse_bool_env("NODE_REPL_TRACE_META", false),
            module_dirs: split_paths(env::var_os("NODE_REPL_NODE_MODULE_DIRS")),
            trusted_code_paths: split_paths(env::var_os("NODE_REPL_TRUSTED_CODE_PATHS")),
            trusted_source_hashes: split_hashes(
                env::var("NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S").ok(),
            ),
            trust_all_imported_code: parse_bool_env("NODE_REPL_TRUST_ALL_CODE", false),
            untrusted_env_allowlist: split_loose(
                env::var("NODE_REPL_UNTRUSTED_ENV_ALLOWLIST").ok(),
            ),
            disable_analytics: !matches!(
                env::var("NODE_REPL_DISABLE_ANALYTICS").as_deref(),
                Ok("0")
            ),
            disable_ambient_network: !matches!(
                env::var("BROWSER_USE_DISABLE_AMBIENT_NETWORK").as_deref(),
                Ok("0")
            ),
            manifest,
            artifact_directory,
            config_file: env::var_os("NODE_REPL_CONFIG_FILE")
                .map(PathBuf::from)
                .unwrap_or_else(|| codex_home.join("config.toml")),
            codex_home,
            native_pipe_connect_timeout: Duration::from_millis(
                env::var("NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(5_000),
            ),
            #[cfg(unix)]
            native_pipe_allowed_roots: split_paths(env::var_os(
                "NODE_REPL_NATIVE_PIPE_ALLOWED_ROOTS",
            )),
            max_native_pipe_connections: env::var("NODE_REPL_NATIVE_PIPE_MAX_CONNECTIONS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(32),
            active_exec_registry_dir: match env::var_os("NODE_REPL_ACTIVE_EXEC_REGISTRY_DIR") {
                Some(value) if value == "0" || value == "false" => None,
                Some(value) => Some(PathBuf::from(value)),
                None => Some(env::temp_dir().join("node_repl").join("active_execs")),
            },
        })
    }
}

struct KernelSession {
    child: Mutex<Child>,
    writer: Arc<Mutex<BufWriter<ChildStdin>>>,
    receiver: Mutex<mpsc::UnboundedReceiver<Value>>,
    stderr: Arc<Mutex<String>>,
    bridge_token: String,
}

#[cfg(unix)]
type PipeWriter = tokio::net::unix::OwnedWriteHalf;
#[cfg(windows)]
type PipeWriter = tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeClient>;

pub struct Runtime {
    options: Mutex<RuntimeOptions>,
    session: Mutex<Option<Arc<KernelSession>>>,
    execution_lock: Mutex<()>,
    host: HostServices,
    elicitor: Mutex<Option<Arc<dyn Elicitor>>>,
    host_call_handler: Mutex<Option<Arc<dyn HostCallHandler>>>,
    #[cfg(any(unix, windows))]
    pipes: Arc<Mutex<HashMap<String, Arc<Mutex<PipeWriter>>>>>,
    sandbox_initialized: AtomicBool,
    sandbox_fingerprint: Mutex<Option<String>>,
    active_exec_files: Mutex<HashMap<String, PathBuf>>,
    active_execution: Mutex<Option<String>>,
    cancelled_executions: Mutex<HashSet<String>>,
}

impl Runtime {
    pub fn new(options: RuntimeOptions) -> Self {
        let host = HostServices {
            image_store: crate::host::image::ImageStore::new(options.artifact_directory.clone()),
            config_store: crate::host::config::ConfigStore::new(
                options.codex_home.clone(),
                options.config_file.clone(),
            ),
            cwd: options.cwd.clone(),
            allowed_fetch_origins: options.manifest.allowed_fetch_origins.clone(),
        };
        Self {
            options: Mutex::new(options),
            session: Mutex::new(None),
            execution_lock: Mutex::new(()),
            host,
            elicitor: Mutex::new(None),
            host_call_handler: Mutex::new(None),
            #[cfg(any(unix, windows))]
            pipes: Arc::new(Mutex::new(HashMap::new())),
            sandbox_initialized: AtomicBool::new(false),
            sandbox_fingerprint: Mutex::new(None),
            active_exec_files: Mutex::new(HashMap::new()),
            active_execution: Mutex::new(None),
            cancelled_executions: Mutex::new(HashSet::new()),
        }
    }

    pub async fn set_elicitor(&self, elicitor: Arc<dyn Elicitor>) {
        *self.elicitor.lock().await = Some(elicitor);
    }

    pub async fn set_host_call_handler(&self, handler: Arc<dyn HostCallHandler>) {
        *self.host_call_handler.lock().await = Some(handler);
    }

    pub async fn execute(
        &self,
        id: String,
        code: String,
        timeout: Option<Duration>,
        request_meta: Option<Value>,
        form_elicitation_supported: bool,
    ) -> Result<ExecutionResult> {
        let _guard = self.execution_lock.lock().await;
        self.ensure_sandbox_state(request_meta.as_ref()).await?;
        let session = self.ensure_session().await?;
        *self.active_execution.lock().await = Some(id.clone());
        if let Err(error) = self
            .publish_active_exec(&id, request_meta.as_ref(), &session)
            .await
        {
            self.clear_active_execution(&id).await;
            return Err(error);
        }
        let timeout = timeout.unwrap_or(self.options.lock().await.default_timeout);
        if let Err(error) = send_value(
            &session.writer,
            &json!({
                "type": "exec",
                "id": id,
                "code": code,
                "request_meta": request_meta,
                "form_elicitation_supported": form_elicitation_supported,
            }),
        )
        .await
        {
            self.remove_active_exec(&id).await;
            self.clear_active_execution(&id).await;
            if self.take_cancelled_execution(&id).await {
                return Ok(cancelled_result(id, None, None, Vec::new()));
            }
            return Err(error);
        }

        let mut redacted_source = None;
        let mut response_meta = None;
        let mut images = Vec::new();
        let mut remaining = timeout;
        let mut timer_started = Instant::now();
        let mut suspension_count = 0u32;
        let mut receiver = session.receiver.lock().await;

        let execution_result: Result<ExecutionResult> = async {
        loop {
            let next = if suspension_count > 0 {
                match receiver.recv().await {
                    Some(message) => message,
                    None if self.take_cancelled_execution(&id).await => {
                        return Ok(cancelled_result(id.clone(), redacted_source, response_meta, images));
                    }
                    None => return Err(anyhow!("node_repl kernel closed")),
                }
            } else {
                let deadline = timer_started + remaining;
                tokio::select! {
                    message = receiver.recv() => match message {
                        Some(message) => message,
                        None if self.take_cancelled_execution(&id).await => {
                            return Ok(cancelled_result(id.clone(), redacted_source, response_meta, images));
                        }
                        None => return Err(anyhow!("node_repl kernel closed")),
                    },
                    _ = sleep_until(deadline) => {
                        drop(receiver);
                        self.reset().await?;
                        return Ok(ExecutionResult {
                            id: id.clone(),
                            ok: false,
                            output: String::new(),
                            error: Some(format!("js execution timed out after {} ms; kernel reset", timeout.as_millis())),
                            redacted_source,
                            response_meta,
                            response_meta_trace: None,
                            images,
                        });
                    }
                }
            };
            let message_type = next.get("type").and_then(Value::as_str).unwrap_or("");
            match message_type {
                "exec_redacted_source" if next.get("id").and_then(Value::as_str) == Some(id.as_str()) => {
                    redacted_source = next.get("source").and_then(Value::as_str).map(ToOwned::to_owned);
                }
                "response_meta" if next.get("id").and_then(Value::as_str) == Some(id.as_str()) => {
                    response_meta = next.get("response_meta").cloned();
                }
                "exec_result" if next.get("id").and_then(Value::as_str) == Some(id.as_str()) => {
                    return Ok(ExecutionResult {
                        id: id.clone(),
                        ok: next.get("ok").and_then(Value::as_bool).unwrap_or(false),
                        output: next.get("output").and_then(Value::as_str).unwrap_or("").to_string(),
                        error: next.get("error").and_then(Value::as_str).map(ToOwned::to_owned),
                        redacted_source,
                        response_meta,
                        response_meta_trace: next.get("response_meta_trace").cloned().filter(|v| !v.is_null()),
                        images,
                    });
                }
                "suspend_timeout" => {
                    self.assert_token(&session, &next)?;
                    if suspension_count == 0 {
                        remaining = remaining.saturating_sub(timer_started.elapsed());
                    }
                    suspension_count += 1;
                }
                "resume_timeout" => {
                    self.assert_token(&session, &next)?;
                    if suspension_count > 0 {
                        suspension_count -= 1;
                        if suspension_count == 0 {
                            timer_started = Instant::now();
                        }
                    }
                }
                "emit_image" => self.handle_emit_image(&session, &next, &mut images).await?,
                "config_action" => {
                    self.assert_token(&session, &next)?;
                    self.handle_config_action(&session, &next).await?;
                }
                "launch_services_action" => {
                    self.assert_token(&session, &next)?;
                    self.handle_launch(&session, &next).await?;
                }
                "authenticated_fetch" => {
                    self.assert_token(&session, &next)?;
                    self.handle_fetch(&session, &next).await?;
                }
                "elicit" => {
                    self.assert_token(&session, &next)?;
                    self.handle_elicitation(&session, &next).await?;
                }
                "lume_host_call" => {
                    self.assert_token(&session, &next)?;
                    self.handle_lume_host_call(&session, &next).await?;
                }
                "native_pipe_request" => {
                    self.assert_token(&session, &next)?;
                    self.handle_native_pipe(&session, &next).await?;
                }
                _ => {}
            }
        }
        }.await;
        self.remove_active_exec(&id).await;
        self.clear_active_execution(&id).await;
        execution_result
    }

    pub async fn add_node_module_dir(&self, path: PathBuf) -> Result<bool> {
        if !path.is_absolute() {
            bail!("js_add_node_module_dir expects an absolute path");
        }
        let mut options = self.options.lock().await;
        if options.module_dirs.iter().any(|entry| entry == &path) {
            return Ok(false);
        }
        options.module_dirs.push(path.clone());
        drop(options);
        if let Some(session) = self.session.lock().await.clone() {
            send_value(
                &session.writer,
                &json!({ "type": "add_node_module_dir", "path": path }),
            )
            .await?;
        }
        Ok(true)
    }

    pub async fn reset(&self) -> Result<()> {
        let session = self.session.lock().await.take();
        if let Some(session) = session {
            let _ = send_value(&session.writer, &json!({ "type": "shutdown" })).await;
            let mut child = session.child.lock().await;
            if tokio::time::timeout(Duration::from_millis(800), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
            }
        }
        self.options.lock().await.session_id = Uuid::new_v4().to_string();
        #[cfg(any(unix, windows))]
        self.pipes.lock().await.clear();
        self.clear_active_execs().await;
        *self.active_execution.lock().await = None;
        Ok(())
    }

    pub async fn cancel(&self, id: &str) -> Result<bool> {
        let matches_active = self.active_execution.lock().await.as_deref() == Some(id);
        if matches_active {
            self.cancelled_executions
                .lock()
                .await
                .insert(id.to_string());
            self.reset().await?;
        }
        Ok(matches_active)
    }

    pub async fn snapshot(&self) -> Value {
        let options = self.options.lock().await.clone();
        let session = self.session.lock().await.clone();
        let (pid, stderr, token) = if let Some(session) = session {
            let pid = session.child.lock().await.id();
            let stderr = session.stderr.lock().await.clone();
            (pid, stderr, Some("[hidden]"))
        } else {
            (None, String::new(), None)
        };
        let node_version = read_node_version(&options.node_path).await.ok();
        let pending_exec_ids = self
            .active_execution
            .lock()
            .await
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        #[cfg(any(unix, windows))]
        let native_pipe_connections = self.pipes.lock().await.len();
        #[cfg(not(any(unix, windows)))]
        let native_pipe_connections = 0usize;
        let sandbox_fingerprint = self.sandbox_fingerprint.lock().await.clone();
        json!({
            "hostPid": std::process::id(),
            "rustHost": true,
            "sessionId": options.session_id,
            "kernelPid": pid,
            "kernelStatus": if pid.is_some() { "ready" } else { "stopped" },
            "kernelStderrTail": tail(&stderr, 8192),
            "nodePath": options.node_path,
            "nodeVersion": node_version,
            "kernelPath": options.kernel_path,
            "moduleDirs": options.module_dirs,
            "pendingExecIds": pending_exec_ids,
            "nativePipeConnections": native_pipe_connections,
            "launchMode": self.launch_mode(&options),
            "sandboxInitialized": self.sandbox_initialized.load(Ordering::SeqCst),
            "sandboxFingerprint": sandbox_fingerprint,
            "activeExecRegistryDir": options.active_exec_registry_dir,
            "bridgeToken": token,
            "transport": "rust-process-jsonl",
        })
    }

    async fn ensure_sandbox_state(&self, request_meta: Option<&Value>) -> Result<()> {
        let state = request_meta.and_then(|meta| meta.get("codex/sandbox-state-meta"));
        let fingerprint = state.map(|value| {
            let encoded = serde_json::to_vec(value).unwrap_or_default();
            hex::encode(Sha256::digest(encoded))
        });
        if !self.sandbox_initialized.swap(true, Ordering::SeqCst) {
            *self.sandbox_fingerprint.lock().await = fingerprint;
            return Ok(());
        }
        let mut current = self.sandbox_fingerprint.lock().await;
        if *current == fingerprint {
            return Ok(());
        }
        *current = fingerprint;
        drop(current);
        if self.session.lock().await.is_some() {
            self.reset().await?;
            bail!("js sandbox changed; kernel reset, rerun your request");
        }
        Ok(())
    }

    async fn publish_active_exec(
        &self,
        exec_id: &str,
        request_meta: Option<&Value>,
        session: &KernelSession,
    ) -> Result<()> {
        let Some(directory) = self.options.lock().await.active_exec_registry_dir.clone() else {
            return Ok(());
        };
        tokio::fs::create_dir_all(&directory).await?;
        let session_id = self.options.lock().await.session_id.clone();
        let kernel_pid = session.child.lock().await.id();
        let turn_id = request_meta
            .and_then(|meta| meta.get("x-codex-turn-metadata"))
            .and_then(|meta| meta.get("turnId"))
            .or_else(|| request_meta.and_then(|meta| meta.get("turnId")))
            .or_else(|| request_meta.and_then(|meta| meta.get("turn_id")))
            .and_then(Value::as_str);
        let record = json!({
            "version": 1,
            "execId": exec_id,
            "sessionId": session_id,
            "turnId": turn_id,
            "nodeReplPid": std::process::id(),
            "kernelPid": kernel_pid,
            "startedAtMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
            "sandbox": request_meta.and_then(|meta| meta.get("codex/sandbox-state-meta")).cloned().unwrap_or(Value::Null),
            "approvedBundleIdentifiers": request_meta.and_then(|meta| meta.get("approvedBundleIdentifiers")).cloned().unwrap_or_else(|| json!([])),
        });
        let safe = |value: &str| {
            value
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                        ch
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
        };
        let final_path = directory.join(format!("{}-{}.json", safe(&session_id), safe(exec_id)));
        let temp_path = final_path.with_extension(format!("json.tmp-{}", Uuid::new_v4()));
        tokio::fs::write(&temp_path, serde_json::to_vec(&record)?).await?;
        tokio::fs::rename(&temp_path, &final_path).await?;
        self.active_exec_files
            .lock()
            .await
            .insert(exec_id.to_string(), final_path);
        Ok(())
    }

    async fn remove_active_exec(&self, exec_id: &str) {
        if let Some(path) = self.active_exec_files.lock().await.remove(exec_id) {
            let _ = tokio::fs::remove_file(path).await;
        }
    }

    async fn clear_active_execs(&self) {
        let paths: Vec<PathBuf> = self
            .active_exec_files
            .lock()
            .await
            .drain()
            .map(|(_, path)| path)
            .collect();
        for path in paths {
            let _ = tokio::fs::remove_file(path).await;
        }
    }

    async fn clear_active_execution(&self, exec_id: &str) {
        let mut active = self.active_execution.lock().await;
        if active.as_deref() == Some(exec_id) {
            *active = None;
        }
    }

    async fn take_cancelled_execution(&self, exec_id: &str) -> bool {
        self.cancelled_executions.lock().await.remove(exec_id)
    }

    async fn ensure_session(&self) -> Result<Arc<KernelSession>> {
        if let Some(session) = self.session.lock().await.clone() {
            return Ok(session);
        }
        let options = self.options.lock().await.clone();
        validate_node_version(&options.node_path, options.minimum_node_version).await?;
        let session = Arc::new(spawn_kernel(&options).await?);
        *self.session.lock().await = Some(session.clone());
        Ok(session)
    }

    fn launch_mode(&self, options: &RuntimeOptions) -> &'static str {
        if !options.disable_sandbox && options.codex_cli_path.is_some() {
            "codex-sandbox"
        } else {
            "direct"
        }
    }

    fn assert_token(&self, session: &KernelSession, message: &Value) -> Result<()> {
        let token = message.get("token").and_then(Value::as_str).unwrap_or("");
        if token != session.bridge_token {
            bail!("invalid privileged bridge token");
        }
        Ok(())
    }

    async fn handle_emit_image(
        &self,
        session: &KernelSession,
        message: &Value,
        images: &mut Vec<ExecutionImage>,
    ) -> Result<()> {
        let id = required_string(message, "id")?;
        let image_url = required_string(message, "image_url")?;
        match self.host.emit_image(image_url).await {
            Ok(image) => {
                images.push(image);
                send_value(&session.writer, &json!({ "type": "emit_image_result", "id": id, "ok": true })).await
            }
            Err(error) => send_value(&session.writer, &json!({ "type": "emit_image_result", "id": id, "ok": false, "error": error.to_string() })).await,
        }
    }

    async fn handle_config_action(&self, session: &KernelSession, message: &Value) -> Result<()> {
        let id = required_string(message, "id")?;
        let object = message
            .as_object()
            .ok_or_else(|| anyhow!("config action must be an object"))?;
        let response = match self.host.config_action(object).await {
            Ok(value) => {
                json!({ "type": "privileged_result", "id": id, "ok": true, "value": value })
            }
            Err(error) => {
                json!({ "type": "privileged_result", "id": id, "ok": false, "error": error.to_string() })
            }
        };
        send_value(&session.writer, &response).await
    }

    async fn handle_launch(&self, session: &KernelSession, message: &Value) -> Result<()> {
        let id = required_string(message, "id")?;
        let object = message
            .as_object()
            .ok_or_else(|| anyhow!("launch action must be an object"))?;
        let response = match self.host.launch_application(object).await {
            Ok(value) => {
                json!({ "type": "privileged_result", "id": id, "ok": true, "value": value })
            }
            Err(error) => {
                json!({ "type": "privileged_result", "id": id, "ok": false, "error": error.to_string() })
            }
        };
        send_value(&session.writer, &response).await
    }

    async fn handle_fetch(&self, session: &KernelSession, message: &Value) -> Result<()> {
        let id = required_string(message, "id")?;
        let request = message
            .get("request")
            .and_then(Value::as_object)
            .ok_or_else(|| anyhow!("request must be an object"))?;
        let response = match self.host.authenticated_fetch(request).await {
            Ok(value) => {
                json!({ "type": "authenticated_fetch_result", "id": id, "ok": true, "response": value })
            }
            Err(error) => {
                json!({ "type": "authenticated_fetch_result", "id": id, "ok": false, "error": error.to_string() })
            }
        };
        send_value(&session.writer, &response).await
    }

    async fn handle_elicitation(&self, session: &KernelSession, message: &Value) -> Result<()> {
        let id = required_string(message, "id")?;
        let elicitor = self.elicitor.lock().await.clone();
        let result = if let Some(elicitor) = elicitor {
            elicitor
                .elicit(
                    message.get("message").and_then(Value::as_str).unwrap_or(""),
                    message
                        .get("requested_schema")
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object" })),
                    message.get("meta").cloned().unwrap_or(Value::Null),
                )
                .await
        } else {
            Ok(json!({ "action": "cancel", "content": Value::Null, "_meta": Value::Null }))
        };
        let response = match result {
            Ok(value) => json!({
                "type": "elicitation_result", "id": id, "ok": true,
                "action": value.get("action").cloned().unwrap_or_else(|| Value::String("cancel".into())),
                "content": value.get("content").cloned().unwrap_or(Value::Null),
                "_meta": value.get("_meta").cloned().unwrap_or(Value::Null),
            }),
            Err(error) => {
                json!({ "type": "elicitation_result", "id": id, "ok": false, "error": error.to_string() })
            }
        };
        send_value(&session.writer, &response).await
    }

    async fn handle_lume_host_call(&self, session: &KernelSession, message: &Value) -> Result<()> {
        let id = required_string(message, "id")?.to_string();
        let exec_id = required_string(message, "exec_id")?.to_string();
        let method = required_string(message, "method")?.to_string();
        let args = message.get("args").cloned().unwrap_or(Value::Null);
        let handler = self.host_call_handler.lock().await.clone();
        let response = if let Some(handler) = handler {
            match handler.call(id.clone(), exec_id, method, args).await {
                Ok(value) => json!({ "type": "lume_host_result", "id": id, "ok": true, "value": value }),
                Err(error) => json!({ "type": "lume_host_result", "id": id, "ok": false, "error": error.to_string() })
            }
        } else {
            json!({ "type": "lume_host_result", "id": id, "ok": false, "error": "lume host call is unavailable" })
        };
        send_value(&session.writer, &response).await
    }

    #[cfg(unix)]
    async fn handle_native_pipe(
        &self,
        session: &Arc<KernelSession>,
        message: &Value,
    ) -> Result<()> {
        use tokio::net::UnixStream;

        let id = required_string(message, "id")?.to_string();
        let operation: Result<Value> = async {
            let op = required_string(message, "op")?;
            match op {
                "connect" => {
                    let path = PathBuf::from(required_string(message, "path")?);
                    self.validate_pipe_path(&path).await?;
                    let max_connections = self.options.lock().await.max_native_pipe_connections;
                    if self.pipes.lock().await.len() >= max_connections {
                        bail!("native pipe connect limiter closed");
                    }
                    let timeout = self.options.lock().await.native_pipe_connect_timeout;
                    let stream = tokio::time::timeout(timeout, UnixStream::connect(&path))
                        .await
                        .context("native pipe connect timed out")??;
                    let connection_id = Uuid::new_v4().to_string();
                    let (mut reader, writer) = stream.into_split();
                    self.pipes
                        .lock()
                        .await
                        .insert(connection_id.clone(), Arc::new(Mutex::new(writer)));

                    let kernel_writer = session.writer.clone();
                    let connection_for_task = connection_id.clone();
                    let pipes = self.pipes.clone();
                    tokio::spawn(async move {
                        let mut buffer = vec![0u8; 64 * 1024];
                        loop {
                            let terminal = match reader.read(&mut buffer).await {
                                Ok(0) => json!({
                                    "type": "native_pipe_closed",
                                    "connection_id": connection_for_task.clone(),
                                }),
                                Ok(count) => {
                                    let encoded = STANDARD.encode(&buffer[..count]);
                                    if send_value(
                                        &kernel_writer,
                                        &json!({
                                            "type": "native_pipe_data",
                                            "connection_id": connection_for_task.clone(),
                                            "data_base64": encoded,
                                        }),
                                    )
                                    .await
                                    .is_err()
                                    {
                                        break;
                                    }
                                    continue;
                                }
                                Err(error) => json!({
                                    "type": "native_pipe_closed",
                                    "connection_id": connection_for_task.clone(),
                                    "error": error.to_string(),
                                }),
                            };
                            let _ = send_value(&kernel_writer, &terminal).await;
                            break;
                        }
                        pipes.lock().await.remove(&connection_for_task);
                    });
                    Ok(json!({ "connection_id": connection_id }))
                }
                "write" => {
                    let connection_id = required_string(message, "connection_id")?;
                    let bytes = STANDARD
                        .decode(required_string(message, "data_base64")?)
                        .context("decode native pipe data")?;
                    let writer = self
                        .pipes
                        .lock()
                        .await
                        .get(connection_id)
                        .cloned()
                        .ok_or_else(|| anyhow!("native pipe connection not found"))?;
                    writer
                        .lock()
                        .await
                        .write_all(&bytes)
                        .await
                        .context("write native pipe")?;
                    Ok(json!({}))
                }
                "close" => {
                    let connection_id = required_string(message, "connection_id")?;
                    let writer = self.pipes.lock().await.remove(connection_id);
                    if let Some(writer) = writer {
                        let _ = writer.lock().await.shutdown().await;
                    }
                    Ok(json!({}))
                }
                _ => bail!("unsupported native pipe operation: {op}"),
            }
        }
        .await;

        let response = match operation {
            Ok(result) => {
                json!({ "type": "native_pipe_response", "id": id, "ok": true, "result": result })
            }
            Err(error) => {
                json!({ "type": "native_pipe_response", "id": id, "ok": false, "error": error.to_string() })
            }
        };
        send_value(&session.writer, &response).await
    }

    #[cfg(windows)]
    async fn handle_native_pipe(
        &self,
        session: &Arc<KernelSession>,
        message: &Value,
    ) -> Result<()> {
        use tokio::net::windows::named_pipe::ClientOptions;

        let id = required_string(message, "id")?.to_string();
        let operation: Result<Value> = async {
            let op = required_string(message, "op")?;
            match op {
                "connect" => {
                    let pipe_path = required_string(message, "path")?;
                    if !pipe_path.starts_with("\\\\.\\pipe\\") {
                        bail!("native pipe path must be an absolute Windows named pipe");
                    }
                    let max_connections = self.options.lock().await.max_native_pipe_connections;
                    if self.pipes.lock().await.len() >= max_connections {
                        bail!("native pipe connect limiter closed");
                    }
                    let timeout = self.options.lock().await.native_pipe_connect_timeout;
                    let client = tokio::time::timeout(timeout, async {
                        loop {
                            match ClientOptions::new().open(pipe_path) {
                                Ok(client) => break Ok(client),
                                Err(error) if error.raw_os_error() == Some(231) => {
                                    tokio::time::sleep(Duration::from_millis(25)).await;
                                }
                                Err(error) => break Err(error),
                            }
                        }
                    })
                    .await
                    .context("native pipe connect timed out")??;
                    let connection_id = Uuid::new_v4().to_string();
                    let (mut reader, writer) = tokio::io::split(client);
                    self.pipes
                        .lock()
                        .await
                        .insert(connection_id.clone(), Arc::new(Mutex::new(writer)));

                    let kernel_writer = session.writer.clone();
                    let connection_for_task = connection_id.clone();
                    let pipes = self.pipes.clone();
                    tokio::spawn(async move {
                        let mut buffer = vec![0u8; 64 * 1024];
                        loop {
                            let terminal = match reader.read(&mut buffer).await {
                                Ok(0) => json!({
                                    "type": "native_pipe_closed",
                                    "connection_id": connection_for_task.clone(),
                                }),
                                Ok(count) => {
                                    let encoded = STANDARD.encode(&buffer[..count]);
                                    if send_value(
                                        &kernel_writer,
                                        &json!({
                                            "type": "native_pipe_data",
                                            "connection_id": connection_for_task.clone(),
                                            "data_base64": encoded,
                                        }),
                                    )
                                    .await
                                    .is_err()
                                    {
                                        break;
                                    }
                                    continue;
                                }
                                Err(error) => json!({
                                    "type": "native_pipe_closed",
                                    "connection_id": connection_for_task.clone(),
                                    "error": error.to_string(),
                                }),
                            };
                            let _ = send_value(&kernel_writer, &terminal).await;
                            break;
                        }
                        pipes.lock().await.remove(&connection_for_task);
                    });
                    Ok(json!({ "connection_id": connection_id }))
                }
                "write" => {
                    let connection_id = required_string(message, "connection_id")?;
                    let bytes = STANDARD
                        .decode(required_string(message, "data_base64")?)
                        .context("decode native pipe data")?;
                    let writer = self
                        .pipes
                        .lock()
                        .await
                        .get(connection_id)
                        .cloned()
                        .ok_or_else(|| anyhow!("native pipe connection not found"))?;
                    writer
                        .lock()
                        .await
                        .write_all(&bytes)
                        .await
                        .context("write native pipe")?;
                    Ok(json!({}))
                }
                "close" => {
                    let connection_id = required_string(message, "connection_id")?;
                    let writer = self.pipes.lock().await.remove(connection_id);
                    if let Some(writer) = writer {
                        let _ = writer.lock().await.shutdown().await;
                    }
                    Ok(json!({}))
                }
                _ => bail!("unsupported native pipe operation: {op}"),
            }
        }
        .await;

        let response = match operation {
            Ok(result) => {
                json!({ "type": "native_pipe_response", "id": id, "ok": true, "result": result })
            }
            Err(error) => {
                json!({ "type": "native_pipe_response", "id": id, "ok": false, "error": error.to_string() })
            }
        };
        send_value(&session.writer, &response).await
    }

    #[cfg(not(any(unix, windows)))]
    async fn handle_native_pipe(
        &self,
        session: &Arc<KernelSession>,
        message: &Value,
    ) -> Result<()> {
        let id = required_string(message, "id")?;
        send_value(&session.writer, &json!({ "type": "native_pipe_response", "id": id, "ok": false, "error": "native pipe is not implemented on this platform" })).await
    }

    #[cfg(unix)]
    async fn validate_pipe_path(&self, path: &Path) -> Result<()> {
        if !path.is_absolute() {
            bail!("native pipe path must be absolute");
        }
        let options = self.options.lock().await;
        if !options.native_pipe_allowed_roots.is_empty()
            && !options
                .native_pipe_allowed_roots
                .iter()
                .any(|root| path.starts_with(root))
        {
            bail!("native pipe request is not authorized");
        }
        let meta = tokio::fs::symlink_metadata(path)
            .await
            .context("native pipe path unavailable")?;
        use std::os::unix::fs::FileTypeExt;
        if !meta.file_type().is_socket() {
            bail!("native pipe path is not a socket");
        }
        Ok(())
    }
}

async fn spawn_kernel(options: &RuntimeOptions) -> Result<KernelSession> {
    let kernel_args = vec![
        "--experimental-vm-modules".to_string(),
        options.kernel_path.to_string_lossy().into_owned(),
        "--session-id".to_string(),
        options.session_id.clone(),
        "--working-dir".to_string(),
        options.cwd.to_string_lossy().into_owned(),
    ];
    let mut command = if !options.disable_sandbox {
        if let Some(codex) = &options.codex_cli_path {
            let mut command = Command::new(codex);
            command.arg("sandbox");
            for socket in &options.sandbox_allowed_unix_sockets {
                command.arg("--allow-unix-socket").arg(socket);
            }
            command.arg("--").arg(&options.node_path).args(&kernel_args);
            command
        } else {
            let mut command = Command::new(&options.node_path);
            command.args(&kernel_args);
            command
        }
    } else {
        let mut command = Command::new(&options.node_path);
        command.args(&kernel_args);
        command
    };
    if options.response_meta_trace {
        command.arg("--response-meta-trace");
    }
    command
        .current_dir(&options.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_kernel_env(&mut command, options)?;
    let mut child = command
        .spawn()
        .with_context(|| format!("start Node kernel {}", options.kernel_path.display()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("kernel stdin unavailable"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("kernel stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("kernel stderr unavailable"))?;
    let writer = Arc::new(Mutex::new(BufWriter::new(stdin)));
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });
    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    let stderr_target = stderr_buffer.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let mut text = stderr_target.lock().await;
                    text.push_str(&String::from_utf8_lossy(&buffer[..count]));
                    if text.len() > 64_000 {
                        let drain = text.len() - 64_000;
                        text.drain(..drain);
                    }
                }
            }
        }
    });
    let handshake = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let value = rx
                .recv()
                .await
                .ok_or_else(|| anyhow!("kernel closed before handshake"))?;
            if value.get("type").and_then(Value::as_str) == Some("privileged_bridge_handshake") {
                return value
                    .get("token")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .ok_or_else(|| anyhow!("invalid privileged bridge handshake"));
            }
        }
    })
    .await
    .context("kernel handshake timed out")??;
    Ok(KernelSession {
        child: Mutex::new(child),
        writer,
        receiver: Mutex::new(rx),
        stderr: stderr_buffer,
        bridge_token: handshake,
    })
}

/// #634：kernel 进程环境白名单。kernel-process 若继承宿主全量环境，任何 vm
/// 边界失守都会把宿主侧注入的全部密钥暴露给 cell 代码（Buffer.constructor
/// realm 逃逸直达 process.env）。只放行系统必需项、代理、untrusted allowlist
/// 声明项与经 NODE_REPL_EXTRA_ENV_ALLOWLIST 显式扩展的条目。
const KERNEL_ENV_BASELINE_ALLOW: &[&str] = &[
    // 桌面生产以 Electron 可执行文件充当 node 运行时（LUME_NODE_REPL_ELECTRON
    // → nodePath），依赖 sidecar 注入的该变量进入 node 模式——缺失则 kernel 以
    // GUI 模式启动、JSONL 握手必超时。
    "ELECTRON_RUN_AS_NODE",
    "PATH",
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
];

#[cfg(target_os = "windows")]
const KERNEL_ENV_WINDOWS_BASELINE_ALLOW: &[&str] = &[
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "COMSPEC",
    "PATHEXT",
    "WINDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
];

fn collect_kernel_env_entries(untrusted_allowlist: &[String]) -> Vec<(String, std::ffi::OsString)> {
    let mut names: Vec<String> = KERNEL_ENV_BASELINE_ALLOW
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    #[cfg(target_os = "windows")]
    names.extend(
        KERNEL_ENV_WINDOWS_BASELINE_ALLOW
            .iter()
            .map(|name| (*name).to_string()),
    );
    // untrusted allowlist 声明的业务变量必须穿透到 kernel，worker 才能按同一
    // 份白名单挑出 untrustedEnv；allowlist 即授权，天然安全。
    names.extend(untrusted_allowlist.iter().cloned());
    names.extend(split_loose(env::var("NODE_REPL_EXTRA_ENV_ALLOWLIST").ok()));
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::new();
    for name in names {
        if !seen.insert(name.clone()) {
            continue;
        }
        if let Some(value) = env::var_os(&name) {
            entries.push((name, value));
        }
    }
    entries
}

fn configure_kernel_env(command: &mut Command, options: &RuntimeOptions) -> Result<()> {
    // #634：kernel-process 若继承宿主全量环境，任何 vm 边界失守都会把宿主侧
    // 注入的全部密钥暴露给 cell 代码（Buffer.constructor realm 逃逸直达
    // process.env）。改为显式白名单（见 collect_kernel_env_entries），其余一律
    // 不传。
    command.env_clear();
    for (name, value) in collect_kernel_env_entries(&options.untrusted_env_allowlist) {
        command.env(name.as_str(), value);
    }
    // env_clear 后本循环对宿主继承值已是 no-op，但保留它兜底：若 allowlist 或
    // 扩展口声明了下列控制变量名，回填值会被剥除，由下方显式设置统一接管。
    for name in [
        "LUME_CUA_RUNTIME_MANIFEST",
        "NODE_REPL_ACTIVE_EXEC_REGISTRY_DIR",
        "NODE_REPL_ALLOWED_FETCH_ORIGINS",
        "NODE_REPL_ALLOW_UNSUPPORTED_NODE",
        "NODE_REPL_ARTIFACT_DIR",
        "NODE_REPL_CONFIG_FILE",
        "NODE_REPL_DEFAULT_TIMEOUT_MS",
        "NODE_REPL_HOST_PATH",
        "NODE_REPL_KERNEL_PATH",
        "NODE_REPL_MINIMUM_NODE_VERSION",
        "NODE_REPL_NATIVE_PIPE_ALLOWED_ROOTS",
        "NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS",
        "NODE_REPL_NATIVE_PIPE_MAX_CONNECTIONS",
        "NODE_REPL_SESSION_ID",
    ] {
        command.env_remove(name);
    }
    command.env(
        "NODE_REPL_NODE_MODULE_DIRS",
        join_paths(&options.module_dirs),
    );
    command.env(
        "NODE_REPL_TRUSTED_CODE_PATHS",
        join_paths(&options.trusted_code_paths),
    );
    command.env(
        "NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S",
        options.trusted_source_hashes.join(","),
    );
    command.env(
        "NODE_REPL_TRUST_ALL_CODE",
        if options.trust_all_imported_code {
            "1"
        } else {
            "0"
        },
    );
    command.env(
        "NODE_REPL_UNTRUSTED_ENV_ALLOWLIST",
        options.untrusted_env_allowlist.join(","),
    );
    command.env(
        "NODE_REPL_DISABLE_ANALYTICS",
        if options.disable_analytics { "1" } else { "0" },
    );
    command.env(
        "BROWSER_USE_DISABLE_AMBIENT_NETWORK",
        if options.disable_ambient_network {
            "1"
        } else {
            "0"
        },
    );
    command.env(
        "LUME_CUA_KERNEL_CONFIG",
        serde_json::to_string(&json!({
            "manifest": options.manifest,
            "exposePrivilegedToRoot": false,
        }))?,
    );
    Ok(())
}

fn cancelled_result(
    id: String,
    redacted_source: Option<String>,
    response_meta: Option<Value>,
    images: Vec<ExecutionImage>,
) -> ExecutionResult {
    ExecutionResult {
        id,
        ok: false,
        output: String::new(),
        error: Some("js execution reset".to_string()),
        redacted_source,
        response_meta,
        response_meta_trace: None,
        images,
    }
}

async fn send_value(writer: &Arc<Mutex<BufWriter<ChildStdin>>>, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    let mut writer = writer.lock().await;
    writer
        .write_all(&bytes)
        .await
        .context("write kernel message")?;
    writer
        .write_all(b"\n")
        .await
        .context("write kernel delimiter")?;
    writer.flush().await.context("flush kernel message")?;
    Ok(())
}

async fn read_node_version(node: &Path) -> Result<String> {
    let output = Command::new(node)
        .arg("--version")
        .output()
        .await
        .with_context(|| format!("Node runtime not found: {}", node.display()))?;
    if !output.status.success() {
        bail!("failed to read Node version (status {})", output.status);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text.trim().trim_start_matches('v');
    parse_version_tuple(version)?;
    Ok(format!("v{version}"))
}

async fn validate_node_version(node: &Path, configured_minimum: (u64, u64, u64)) -> Result<String> {
    let resolved = read_node_version(node).await?;
    let version = resolved.trim_start_matches('v');
    let tuple = parse_version_tuple(version)?;
    let minimum = if env::var("NODE_REPL_ALLOW_UNSUPPORTED_NODE").as_deref() == Ok("1") {
        (22, 0, 0)
    } else {
        configured_minimum
    };
    if tuple < minimum {
        bail!(
            "Node runtime too old for node_repl (resolved v{version}, requires >={}.{}.{})",
            minimum.0,
            minimum.1,
            minimum.2
        );
    }
    Ok(format!("v{version}"))
}

fn parse_version_tuple(value: &str) -> Result<(u64, u64, u64)> {
    let clean = value.trim().trim_start_matches('v');
    let mut parts = clean.split('.');
    let major = parts
        .next()
        .ok_or_else(|| anyhow!("invalid version: {value}"))?
        .parse::<u64>()
        .with_context(|| format!("invalid version: {value}"))?;
    let minor = parts
        .next()
        .unwrap_or("0")
        .parse::<u64>()
        .with_context(|| format!("invalid version: {value}"))?;
    let patch_text = parts.next().unwrap_or("0");
    let patch = patch_text
        .split(|character: char| !character.is_ascii_digit())
        .next()
        .unwrap_or("0")
        .parse::<u64>()
        .with_context(|| format!("invalid version: {value}"))?;
    Ok((major, minor, patch))
}

fn resolve_kernel_path() -> Result<PathBuf> {
    let executable = env::current_exe().context("resolve node_repl executable")?;
    let directory = executable.parent().unwrap_or_else(|| Path::new("."));
    let candidates = [
        directory.join("kernel-process.js"),
        directory
            .join("..")
            .join("dist")
            .join("runtime")
            .join("kernel-process.js"),
        directory
            .join("..")
            .join("..")
            .join("dist")
            .join("runtime")
            .join("kernel-process.js"),
        directory
            .join("..")
            .join("..")
            .join("..")
            .join("dist")
            .join("runtime")
            .join("kernel-process.js"),
        directory
            .join("..")
            .join("lib")
            .join("node_modules")
            .join("@lume")
            .join("cua")
            .join("dist")
            .join("runtime")
            .join("kernel-process.js"),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    bail!("node_repl kernel not found; set NODE_REPL_KERNEL_PATH")
}

fn split_paths(value: Option<std::ffi::OsString>) -> Vec<PathBuf> {
    value
        .map(|raw| env::split_paths(&raw).collect())
        .unwrap_or_default()
}

fn split_loose(value: Option<String>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split([',', ';', '\n'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn split_hashes(value: Option<String>) -> Vec<String> {
    split_loose(value)
        .into_iter()
        .filter_map(|entry| {
            let trimmed = entry
                .strip_prefix("sha256:")
                .unwrap_or(&entry)
                .to_ascii_lowercase();
            (trimmed.len() == 64 && trimmed.chars().all(|ch| ch.is_ascii_hexdigit()))
                .then_some(trimmed)
        })
        .collect()
}

fn join_paths(paths: &[PathBuf]) -> std::ffi::OsString {
    env::join_paths(paths).unwrap_or_default()
}

fn required_string<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("{name} must be a string"))
}

fn tail(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut start = value.len().saturating_sub(max);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::{collect_kernel_env_entries, parse_version_tuple, split_hashes, tail};

    #[test]
    fn kernel_env_allowlist_only_passes_declared_entries() {
        // 测试进程必有 PATH；断言基线穿透。
        let entries = collect_kernel_env_entries(&[]);
        let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
        assert!(names.contains(&"PATH"), "baseline PATH must pass through");
        // 未声明的变量（宿主 env 里存在与否不定）绝不出现在结果中——
        // 结果集合必须等于「基线 ∪ allowlist ∪ extra」与进程 env 的交集。
        let declared = vec!["PATH".to_string(), "NODE_REPL_TEST_MISSING_VAR".to_string()];
        let entries = collect_kernel_env_entries(&declared);
        let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
        assert!(names.contains(&"PATH"));
        // allowlist 声明但进程中不存在的条目被静默跳过，不产生空值注入
        assert!(!names.contains(&"NODE_REPL_TEST_MISSING_VAR"));
        // #634 review 加固：负向钉死「未声明的现存变量绝不透出」。cargo test 进程
        // 必注入 CARGO_* 系列（不在任何 baseline）；若白名单机制整体回退为继承全量
        // 环境，本断言红——此前仅有正向断言时该回退变异存活。
        if std::env::var_os("CARGO_PKG_NAME").is_some() {
            assert!(
                !names.contains(&"CARGO_PKG_NAME"),
                "undeclared process env must not leak into the kernel allowlist result"
            );
        }
    }

    #[test]
    fn kernel_env_extra_allowlist_extends_pass_through() {
        // NODE_REPL_EXTRA_ENV_ALLOWLIST 引用 baseline 外的自造变量验证扩展口穿透
        // （#634 review 加固）：曾用 HOME 作探针，而 HOME 本就在 KERNEL_ENV_BASELINE_
        // ALLOW 内，删掉扩展口解析行后结果仍含 HOME、测试恒绿（变异存活）。
        let guard_extra = super::env::var("NODE_REPL_EXTRA_ENV_ALLOWLIST").ok();
        let guard_canary = super::env::var("NODE_REPL_TEST_EXTRA_CANARY").ok();
        unsafe { super::env::set_var("NODE_REPL_TEST_EXTRA_CANARY", "canary-value") };
        unsafe { super::env::set_var("NODE_REPL_EXTRA_ENV_ALLOWLIST", "NODE_REPL_TEST_EXTRA_CANARY") };
        let entries = collect_kernel_env_entries(&[]);
        let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
        assert!(
            names.iter().any(|name| *name == "NODE_REPL_TEST_EXTRA_CANARY"),
            "extra allowlist entry outside every baseline must pass through"
        );
        unsafe {
            match &guard_extra {
                Some(value) => super::env::set_var("NODE_REPL_EXTRA_ENV_ALLOWLIST", value),
                None => super::env::remove_var("NODE_REPL_EXTRA_ENV_ALLOWLIST"),
            }
            match &guard_canary {
                Some(value) => super::env::set_var("NODE_REPL_TEST_EXTRA_CANARY", value),
                None => super::env::remove_var("NODE_REPL_TEST_EXTRA_CANARY"),
            }
        }
    }

    #[test]
    fn parses_semver_and_prerelease_versions() {
        assert_eq!(parse_version_tuple("v22.22.0").unwrap(), (22, 22, 0));
        assert_eq!(parse_version_tuple("24.1.2-nightly").unwrap(), (24, 1, 2));
        assert_eq!(parse_version_tuple("23").unwrap(), (23, 0, 0));
    }

    #[test]
    fn filters_and_normalizes_source_hashes() {
        let valid = "A".repeat(64);
        let hashes = split_hashes(Some(format!("sha256:{valid},bad;{}", "b".repeat(64))));
        assert_eq!(hashes, vec!["a".repeat(64), "b".repeat(64)]);
    }

    #[test]
    fn tail_preserves_utf8_boundaries() {
        assert_eq!(tail("abcdef", 3), "def");
        let result = tail("start-你好世界", 7);
        assert!(result.is_char_boundary(0));
        assert!("start-你好世界".ends_with(&result));
    }
}
