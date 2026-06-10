//! N-API bridge for code summarization via lume-ast.
//! License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct JsSummaryOptions {
    pub code: String,
    pub lang: Option<String>,
    pub path: Option<String>,
    pub min_body_lines: Option<u32>,
    pub min_comment_lines: Option<u32>,
    pub unfold_until_lines: Option<u32>,
    pub unfold_limit_lines: Option<u32>,
}

#[napi(object)]
pub struct JsSummarySegment {
    pub kind: String,
    pub start_line: u32,
    pub end_line: u32,
    pub text: Option<String>,
}

#[napi(object)]
pub struct JsSummaryResult {
    pub language: Option<String>,
    pub parsed: bool,
    pub elided: bool,
    pub total_lines: u32,
    pub segments: Vec<JsSummarySegment>,
}

/// Produce a structural summary of source code using tree-sitter.
///
/// Returns kept/elided segments showing imports, function signatures,
/// class definitions, etc. — with bodies elided for long files.
#[napi]
pub fn summarize(options: JsSummaryOptions) -> Result<JsSummaryResult> {
    let rust_options = lume_ast::summary::SummaryOptions {
        code: options.code,
        lang: options.lang,
        path: options.path,
        min_body_lines: options.min_body_lines,
        min_comment_lines: options.min_comment_lines,
        unfold_until_lines: options.unfold_until_lines,
        unfold_limit_lines: options.unfold_limit_lines,
    };

    let result = lume_ast::summary::summarize_code(rust_options)
        .map_err(|e| Error::from_reason(format!("summarize failed: {e}")))?; // correct

    Ok(JsSummaryResult {
        language: result.language,
        parsed: result.parsed,
        elided: result.elided,
        total_lines: result.total_lines,
        segments: result
            .segments
            .into_iter()
            .map(|s| JsSummarySegment {
                kind: s.kind,
                start_line: s.start_line,
                end_line: s.end_line,
                text: s.text,
            })
            .collect(),
    })
}
