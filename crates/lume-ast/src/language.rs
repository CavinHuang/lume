//! Simplified language definitions for tree-sitter parsing.
//! License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük

use std::path::Path;
use tree_sitter::Language;

/// Supported languages for code summarization.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupportLang {
    #[cfg(feature = "lang-bash")]
    Bash,
    #[cfg(feature = "lang-c")]
    C,
    #[cfg(feature = "lang-cpp")]
    Cpp,
    #[cfg(feature = "lang-css")]
    Css,
    #[cfg(feature = "lang-go")]
    Go,
    #[cfg(feature = "lang-html")]
    Html,
    #[cfg(feature = "lang-java")]
    Java,
    #[cfg(feature = "lang-javascript")]
    JavaScript,
    #[cfg(feature = "lang-json")]
    Json,
    #[cfg(feature = "lang-markdown")]
    Markdown,
    #[cfg(feature = "lang-python")]
    Python,
    #[cfg(feature = "lang-rust")]
    Rust,
    #[cfg(feature = "lang-toml")]
    Toml,
    #[cfg(feature = "lang-typescript")]
    TypeScript,
    #[cfg(feature = "lang-yaml")]
    Yaml,
}

impl SupportLang {
    pub fn from_alias(value: &str) -> Option<Self> {
        let lowered = value.trim().to_ascii_lowercase();
        match lowered.as_str() {
            #[cfg(feature = "lang-bash")]
            "bash" | "sh" | "zsh" => Some(Self::Bash),
            #[cfg(feature = "lang-c")]
            "c" | "h" => Some(Self::C),
            #[cfg(feature = "lang-cpp")]
            "cpp" | "c++" | "cc" | "cxx" | "hpp" | "hh" => Some(Self::Cpp),
            #[cfg(feature = "lang-css")]
            "css" | "scss" => Some(Self::Css),
            #[cfg(feature = "lang-go")]
            "go" | "golang" => Some(Self::Go),
            #[cfg(feature = "lang-html")]
            "html" | "htm" => Some(Self::Html),
            #[cfg(feature = "lang-java")]
            "java" => Some(Self::Java),
            #[cfg(feature = "lang-javascript")]
            "javascript" | "js" | "jsx" | "mjs" | "cjs" => Some(Self::JavaScript),
            #[cfg(feature = "lang-json")]
            "json" => Some(Self::Json),
            #[cfg(feature = "lang-markdown")]
            "markdown" | "md" | "mdx" => Some(Self::Markdown),
            #[cfg(feature = "lang-python")]
            "python" | "py" | "py3" | "pyi" => Some(Self::Python),
            #[cfg(feature = "lang-rust")]
            "rust" | "rs" => Some(Self::Rust),
            #[cfg(feature = "lang-toml")]
            "toml" => Some(Self::Toml),
            #[cfg(feature = "lang-typescript")]
            "typescript" | "ts" | "tsx" | "mts" | "cts" => Some(Self::TypeScript),
            #[cfg(feature = "lang-yaml")]
            "yaml" | "yml" => Some(Self::Yaml),
            _ => None,
        }
    }

    pub fn from_path(path: &Path) -> Option<Self> {
        #[cfg(feature = "lang-bash")]
        {
            let name = path.file_name()?.to_str()?;
            if name == "Makefile" || name == "makefile" {
                return Some(Self::Bash);
            }
        }
        let ext = path.extension()?.to_str()?;
        Self::from_alias(ext)
    }

    pub fn get_ts_language(self) -> Language {
        match self {
            #[cfg(feature = "lang-bash")]
            Self::Bash => tree_sitter_bash::LANGUAGE.into(),
            #[cfg(feature = "lang-c")]
            Self::C => tree_sitter_c::LANGUAGE.into(),
            #[cfg(feature = "lang-cpp")]
            Self::Cpp => tree_sitter_cpp::LANGUAGE.into(),
            #[cfg(feature = "lang-css")]
            Self::Css => tree_sitter_css::LANGUAGE.into(),
            #[cfg(feature = "lang-go")]
            Self::Go => tree_sitter_go::LANGUAGE.into(),
            #[cfg(feature = "lang-html")]
            Self::Html => tree_sitter_html::LANGUAGE.into(),
            #[cfg(feature = "lang-java")]
            Self::Java => tree_sitter_java::LANGUAGE.into(),
            #[cfg(feature = "lang-javascript")]
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            #[cfg(feature = "lang-json")]
            Self::Json => tree_sitter_json::LANGUAGE.into(),
            #[cfg(feature = "lang-markdown")]
            Self::Markdown => tree_sitter_md::LANGUAGE.into(),
            #[cfg(feature = "lang-python")]
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            #[cfg(feature = "lang-rust")]
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            #[cfg(feature = "lang-toml")]
            Self::Toml => tree_sitter_toml_ng::LANGUAGE.into(),
            #[cfg(feature = "lang-typescript")]
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            #[cfg(feature = "lang-yaml")]
            Self::Yaml => tree_sitter_yaml::LANGUAGE.into(),
        }
    }

    pub fn canonical_name(self) -> &'static str {
        match self {
            #[cfg(feature = "lang-bash")]
            Self::Bash => "bash",
            #[cfg(feature = "lang-c")]
            Self::C => "c",
            #[cfg(feature = "lang-cpp")]
            Self::Cpp => "cpp",
            #[cfg(feature = "lang-css")]
            Self::Css => "css",
            #[cfg(feature = "lang-go")]
            Self::Go => "go",
            #[cfg(feature = "lang-html")]
            Self::Html => "html",
            #[cfg(feature = "lang-java")]
            Self::Java => "java",
            #[cfg(feature = "lang-javascript")]
            Self::JavaScript => "javascript",
            #[cfg(feature = "lang-json")]
            Self::Json => "json",
            #[cfg(feature = "lang-markdown")]
            Self::Markdown => "markdown",
            #[cfg(feature = "lang-python")]
            Self::Python => "python",
            #[cfg(feature = "lang-rust")]
            Self::Rust => "rust",
            #[cfg(feature = "lang-toml")]
            Self::Toml => "toml",
            #[cfg(feature = "lang-typescript")]
            Self::TypeScript => "typescript",
            #[cfg(feature = "lang-yaml")]
            Self::Yaml => "yaml",
        }
    }
}
