mod cli;
mod control;
mod host;
mod kernel;
mod logging;
mod mcp;
mod protocol;

use std::sync::Arc;

use anyhow::Result;
use cli::{Cli, Mode, HELP, SERVER_VERSION};
use kernel::{Runtime, RuntimeOptions};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        logging::emit_log("fatal", "repl.lifecycle", "run.failed", &format!("node_repl failed: {error:#}"), None);
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = match Cli::parse() {
        Ok(cli) => cli,
        Err(error) => {
            logging::emit_log("warn", "repl.lifecycle", "args.invalid",
                &format!("node_repl argument parsing failed: {error}"), None);
            std::process::exit(2);
        }
    };
    if cli.print_help {
        print!("{HELP}");
        return Ok(());
    }
    if cli.print_version {
        println!("node_repl {SERVER_VERSION}");
        return Ok(());
    }
    let options = RuntimeOptions::from_environment(
        cli.working_dir,
        cli.node_path,
        cli.kernel_path,
        cli.disable_sandbox,
    )?;
    let runtime = Arc::new(Runtime::new(options));
    match cli.mode {
        Mode::Mcp => mcp::McpServer::new(runtime).await.run().await,
        Mode::RuntimeJsonl => control::run(runtime).await,
    }
}
