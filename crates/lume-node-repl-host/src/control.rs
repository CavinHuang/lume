use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter},
    sync::{mpsc, oneshot, Mutex},
    task::JoinSet,
};
use uuid::Uuid;

use crate::{
    kernel::{HostCallHandler, Runtime},
    protocol::{RuntimeControlRequest, RuntimeControlResponse},
};

pub async fn run(runtime: Arc<Runtime>) -> Result<()> {
    let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<Value>();
    let host_bridge = Arc::new(ControlHostCallBridge::new(writer_tx.clone()));
    runtime.set_host_call_handler(host_bridge.clone()).await;
    let writer_task = tokio::spawn(async move {
        let mut output = BufWriter::new(tokio::io::stdout());
        while let Some(response) = writer_rx.recv().await {
            write(&mut output, &response).await?;
        }
        Result::<()>::Ok(())
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut requests = JoinSet::new();
    let mut explicit_shutdown = false;
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<RuntimeControlRequest>(&line) {
            Ok(request) => request,
            Err(error) => {
                let _ = writer_tx.send(serde_json::to_value(RuntimeControlResponse::failure(
                    "invalid".into(),
                    error.to_string(),
                ))?);
                continue;
            }
        };
        if request.method == "host_result" {
            host_bridge.resolve(request.params).await;
            continue;
        }
        let should_shutdown = request.method == "shutdown";
        let runtime = runtime.clone();
        let writer = writer_tx.clone();
        requests.spawn(async move {
            let request_id = request.request_id.clone();
            let response = match handle(runtime, request).await {
                Ok(value) => RuntimeControlResponse::success(request_id, value),
                Err(error) => RuntimeControlResponse::failure(request_id, error.to_string()),
            };
            let _ = writer.send(serde_json::to_value(response).unwrap_or_else(|error| {
                json!({
                    "type": "runtime_response",
                    "request_id": "invalid",
                    "ok": false,
                    "error": error.to_string()
                })
            }));
        });
        if should_shutdown {
            explicit_shutdown = true;
            break;
        }
    }

    if !explicit_shutdown {
        runtime.reset().await?;
    }
    if !requests.is_empty() {
        while requests.join_next().await.is_some() {}
    }
    runtime.reset().await?;
    drop(writer_tx);
    writer_task.await??;
    Ok(())
}

async fn handle(runtime: Arc<Runtime>, request: RuntimeControlRequest) -> Result<Value> {
    match request.method.as_str() {
        "exec" => {
            let code = request
                .params
                .get("code")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("code must be a string"))?;
            let id = request
                .params
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            let timeout = request
                .params
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .map(Duration::from_millis);
            let request_meta = request
                .params
                .get("request_meta")
                .cloned()
                .filter(|value| !value.is_null());
            let form_supported = request
                .params
                .get("form_elicitation_supported")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(serde_json::to_value(
                runtime
                    .execute(id, code.to_string(), timeout, request_meta, form_supported)
                    .await?,
            )?)
        }
        "reset" => {
            runtime.reset().await?;
            Ok(json!({}))
        }
        "add_node_module_dir" => {
            let path = request
                .params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("path must be a string"))?;
            Ok(Value::Bool(
                runtime.add_node_module_dir(PathBuf::from(path)).await?,
            ))
        }
        "cancel" => {
            let id = request
                .params
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("id must be a string"))?;
            Ok(Value::Bool(runtime.cancel(id).await?))
        }
        "snapshot" => Ok(runtime.snapshot().await),
        "shutdown" => {
            runtime.reset().await?;
            Ok(json!({ "shutdown": true }))
        }
        other => Err(anyhow!("unknown runtime method: {other}")),
    }
}

struct ControlHostCallBridge {
    writer: mpsc::UnboundedSender<Value>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

impl ControlHostCallBridge {
    fn new(writer: mpsc::UnboundedSender<Value>) -> Self {
        Self {
            writer,
            pending: Mutex::new(HashMap::new()),
        }
    }

    async fn resolve(&self, params: Value) {
        let Some(id) = params.get("id").and_then(Value::as_str).map(ToOwned::to_owned) else {
            return;
        };
        let ok = params.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let value = params.get("value").cloned().unwrap_or(Value::Null);
        let error = params
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("lume host call failed")
            .to_string();
        if let Some(sender) = self.pending.lock().await.remove(&id) {
            let _ = sender.send(if ok { Ok(value) } else { Err(error) });
        }
    }
}

#[async_trait]
impl HostCallHandler for ControlHostCallBridge {
    async fn call(&self, id: String, exec_id: String, method: String, args: Value) -> Result<Value> {
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), sender);
        if self
            .writer
            .send(json!({
                "type": "runtime_host_call",
                "id": id.clone(),
                "exec_id": exec_id,
                "method": method,
                "args": args
            }))
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            bail!("runtime host-call writer is closed");
        }

        match tokio::time::timeout(Duration::from_secs(5 * 60), receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(anyhow!(error)),
            Ok(Err(_)) => Err(anyhow!("runtime host-call response channel closed")),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(anyhow!("runtime host-call timed out"))
            }
        }
    }
}

async fn write<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    writer.write_all(&bytes).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}
