use std::{env, path::PathBuf};

pub const SERVER_VERSION: &str = "0.1.0";
pub const HELP: &str = "Run the node_repl MCP stdio server.\n\nUsage: node_repl [OPTIONS]\n\nOptions:\n      --disable-sandbox  Start the Node kernel directly even when CODEX_CLI_PATH is set\n  -h, --help             Print help\n  -V, --version          Print version\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Mcp,
    RuntimeJsonl,
}

#[derive(Debug, Clone)]
pub struct Cli {
    pub disable_sandbox: bool,
    pub mode: Mode,
    pub kernel_path: Option<PathBuf>,
    pub node_path: Option<PathBuf>,
    pub working_dir: Option<PathBuf>,
    pub print_help: bool,
    pub print_version: bool,
}

impl Cli {
    pub fn parse() -> Result<Self, String> {
        let mut cli = Self {
            disable_sandbox: parse_bool_env("DISABLE_SANDBOX", false),
            mode: Mode::Mcp,
            kernel_path: None,
            node_path: None,
            working_dir: None,
            print_help: false,
            print_version: false,
        };
        let args: Vec<String> = env::args().skip(1).collect();
        let mut index = 0usize;
        while index < args.len() {
            match args[index].as_str() {
                "--disable-sandbox" => cli.disable_sandbox = true,
                "--runtime-jsonl" => cli.mode = Mode::RuntimeJsonl,
                "--kernel-path" => {
                    index += 1;
                    cli.kernel_path = Some(PathBuf::from(
                        args.get(index).ok_or("missing value for --kernel-path")?,
                    ));
                }
                "--node-path" => {
                    index += 1;
                    cli.node_path = Some(PathBuf::from(
                        args.get(index).ok_or("missing value for --node-path")?,
                    ));
                }
                "--working-dir" => {
                    index += 1;
                    cli.working_dir = Some(PathBuf::from(
                        args.get(index).ok_or("missing value for --working-dir")?,
                    ));
                }
                "-h" | "--help" => cli.print_help = true,
                "-V" | "--version" => cli.print_version = true,
                other => return Err(format!("unexpected argument '{other}'")),
            }
            index += 1;
        }
        Ok(cli)
    }
}

pub fn parse_bool_env(name: &str, fallback: bool) -> bool {
    match env::var(name) {
        Ok(value) if value == "1" || value.eq_ignore_ascii_case("true") => true,
        Ok(value) if value == "0" || value.eq_ignore_ascii_case("false") => false,
        Ok(value) if value.is_empty() => fallback,
        Err(_) => fallback,
        _ => fallback,
    }
}
