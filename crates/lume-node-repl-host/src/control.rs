use std::{path::PathBuf, sync::Arc, time::Duration};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter},
    sync::mpsc,
    task::JoinSet,
};
use uuid::Uuid;

use crate::{
    kernel::Runtime,
    protocol::{RuntimeControlRequest, RuntimeControlResponse},
};

pub async fn run(runtime: Arc<Runtime>) -> Result<()> {
    let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<RuntimeControlResponse>();
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
                let _ = writer_tx.send(RuntimeControlResponse::failure(
                    "invalid".into(),
                    error.to_string(),
                ));
                continue;
            }
        };
        let should_shutdown = request.method == "shutdown";
        let runtime = runtime.clone();
        let writer = writer_tx.clone();
        requests.spawn(async move {
            let request_id = request.request_id.clone();
            let response = match handle(runtime, request).await {
                Ok(value) => RuntimeControlResponse::success(request_id, value),
                Err(error) => RuntimeControlResponse::failure(request_id, error.to_string()),
            };
            let _ = writer.send(response);
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

async fn write<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    value: &RuntimeControlResponse,
) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    writer.write_all(&bytes).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;
    Ok(())
}
