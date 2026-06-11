//! Structural source summaries powered by tree-sitter.
//!
//! Adapted from oh-my-pi pi-ast/src/summary.rs
//! License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük

use std::collections::BTreeSet;
use std::path::Path;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser};

use crate::language::SupportLang;

const DEFAULT_MIN_BODY_LINES: u32 = 4;
const DEFAULT_MIN_COMMENT_LINES: u32 = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryOptions {
    /// Source code to summarize.
    pub code: String,
    /// Language alias (e.g. "rust", "typescript") used before path inference.
    pub lang: Option<String>,
    /// File path used to infer language by extension when `lang` is omitted.
    pub path: Option<String>,
    /// Minimum total node lines before eliding a body/literal node.
    pub min_body_lines: Option<u32>,
    /// Minimum total comment lines before eliding a multiline block comment.
    pub min_comment_lines: Option<u32>,
    /// Target visible-line count for BFS unfold. Starting from every elidable
    /// span folded, this progressively reveals outer-then-inner spans until
    /// the visible line count meets the target. `None` or `0` disables BFS
    /// and keeps only the outermost elisions (every nested span stays hidden
    /// behind its parent).
    pub unfold_until_lines: Option<u32>,
    /// Hard ceiling for BFS unfold. If a candidate unfold would push the
    /// visible count past this value, revert that step and stop. Defaults
    /// to `unfold_until_lines * 2` when omitted (with `unfold_until_lines`
    /// itself as the floor so a single threshold also works).
    pub unfold_limit_lines: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SummarySegment {
    /// "kept" or "elided".
    pub kind: String,
    /// 1-based inclusive start line.
    pub start_line: u32,
    /// 1-based inclusive end line.
    pub end_line: u32,
    /// Verbatim text for kept segments; absent for elided segments.
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SummaryResult {
    /// Canonical language name when parsing succeeded.
    pub language: Option<String>,
    /// True when tree-sitter parsed the source without syntax errors.
    pub parsed: bool,
    /// True when at least one elision span was emitted.
    pub elided: bool,
    /// Total source lines.
    pub total_lines: u32,
    /// Kept/elided segments in source order.
    pub segments: Vec<SummarySegment>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LineSpan {
    start: u32,
    end: u32,
}

impl LineSpan {
    const fn lines(self) -> u32 {
        self.end.saturating_sub(self.start).saturating_add(1)
    }
}

/// One elidable region plus its directly-nested elidable descendants. The
/// forest is built by AST traversal in source order, so `children` reflects
/// the structural hierarchy: a child's span is always strictly contained
/// within its parent's.
#[derive(Debug)]
struct SpanNode {
    span: LineSpan,
    children: Vec<usize>,
}

/// Flat arena of elidable spans organized as a forest. `roots` lists the
/// topmost spans — anything whose AST ancestors held no elidable container.
#[derive(Debug, Default)]
struct ElidableForest {
    nodes: Vec<SpanNode>,
    roots: Vec<usize>,
}

impl ElidableForest {
    fn push(&mut self, parent: Option<usize>, span: LineSpan) -> usize {
        let idx = self.nodes.len();
        self.nodes.push(SpanNode {
            span,
            children: Vec::new(),
        });
        match parent {
            Some(p) => self.nodes[p].children.push(idx),
            None => self.roots.push(idx),
        }
        idx
    }
}

/// BFS unfold. Start with every root span folded (matches the legacy
/// outermost-only behavior) and progressively replace folded spans with
/// their elidable children, breadth-first, until the visible line count
/// reaches `unfold_until`. A candidate unfold that would push the visible
/// count past `unfold_limit` is rejected and aborts the loop ("revert the
/// last unfold because it overflew"). `unfold_until == 0` short-circuits
/// to the legacy behavior.
fn select_folded_spans(
    forest: &ElidableForest,
    total_lines: u32,
    unfold_until: u32,
    unfold_limit: u32,
) -> Vec<LineSpan> {
    use std::collections::{HashSet, VecDeque};

    let nodes = &forest.nodes;
    let mut folded: HashSet<usize> = forest.roots.iter().copied().collect();

    if unfold_until == 0 || folded.is_empty() {
        return folded.into_iter().map(|i| nodes[i].span).collect();
    }

    let folded_line_total: u32 = folded.iter().map(|&i| nodes[i].span.lines()).sum();
    let mut visible = total_lines.saturating_sub(folded_line_total);
    let mut queue: VecDeque<usize> = forest.roots.iter().copied().collect();

    while let Some(idx) = queue.pop_front() {
        if visible >= unfold_until {
            break;
        }
        if !folded.contains(&idx) {
            continue;
        }
        let node = &nodes[idx];
        let child_line_total: u32 = node.children.iter().map(|&c| nodes[c].span.lines()).sum();
        let revealed = node.span.lines().saturating_sub(child_line_total);
        let new_visible = visible.saturating_add(revealed);
        if new_visible > unfold_limit {
            break;
        }
        folded.remove(&idx);
        for &c in &node.children {
            folded.insert(c);
            queue.push_back(c);
        }
        visible = new_visible;
    }

    folded.into_iter().map(|i| nodes[i].span).collect()
}

pub fn summarize_code(options: SummaryOptions) -> Result<SummaryResult> {
    let source = options.code;
    let total_lines = count_lines(&source);

    if source.is_empty() {
        return Ok(unparsed_result(source, total_lines));
    }

    let Some(language) = resolve_language(options.lang.as_deref(), options.path.as_deref()) else {
        return Ok(unparsed_result(source, total_lines));
    };

    let mut parser = Parser::new();
    parser
        .set_language(&language.get_ts_language())
        .map_err(|err| anyhow!("Failed to load tree-sitter language: {err}"))?;

    let Some(tree) = parser.parse(&source, None) else {
        return Ok(unparsed_result(source, total_lines));
    };

    let root = tree.root_node();
    if root.has_error() {
        return Ok(unparsed_result(source, total_lines));
    }

    let min_body_lines = options
        .min_body_lines
        .unwrap_or(DEFAULT_MIN_BODY_LINES)
        .max(2);
    let min_comment_lines = options
        .min_comment_lines
        .unwrap_or(DEFAULT_MIN_COMMENT_LINES)
        .max(4);
    let unfold_until = options.unfold_until_lines.unwrap_or(0);
    let unfold_limit = options
        .unfold_limit_lines
        .unwrap_or_else(|| unfold_until.saturating_mul(2));

    let mut forest = ElidableForest::default();
    collect_elidable_tree(root, None, language, min_body_lines, min_comment_lines, &mut forest);

    let spans = select_folded_spans(&forest, total_lines, unfold_until, unfold_limit);
    let spans = normalize_spans(spans, total_lines);
    let segments = build_segments(&source, total_lines, &spans);

    Ok(SummaryResult {
        language: Some(language.canonical_name().to_string()),
        parsed: true,
        elided: !spans.is_empty(),
        total_lines,
        segments,
    })
}

pub(crate) fn resolve_language(lang: Option<&str>, path: Option<&str>) -> Option<SupportLang> {
    if let Some(lang) = lang.map(str::trim).filter(|lang| !lang.is_empty()) {
        return SupportLang::from_alias(lang);
    }
    let path = path?.trim();
    if path.is_empty() {
        return None;
    }
    SupportLang::from_path(Path::new(path))
}

fn unparsed_result(source: String, total_lines: u32) -> SummaryResult {
    let segments = if source.is_empty() {
        Vec::new()
    } else {
        vec![SummarySegment {
            kind: "kept".to_string(),
            start_line: 1,
            end_line: total_lines,
            text: Some(source),
        }]
    };
    SummaryResult {
        language: None,
        parsed: false,
        elided: false,
        total_lines,
        segments,
    }
}

fn count_lines(source: &str) -> u32 {
    if source.is_empty() {
        0
    } else {
        source.lines().count().max(1).min(u32::MAX as usize) as u32
    }
}

fn collect_elidable_tree(
    node: Node<'_>,
    elidable_parent: Option<usize>,
    language: SupportLang,
    min_body_lines: u32,
    min_comment_lines: u32,
    forest: &mut ElidableForest,
) {
    let total_lines = node_line_count(node);

    if is_comment_kind(language, node.kind()) {
        if total_lines >= min_comment_lines {
            let start_line = node_start_line(node) + 2;
            let end_line = node_end_line(node).saturating_sub(1);
            if start_line <= end_line {
                forest.push(elidable_parent, LineSpan { start: start_line, end: end_line });
            }
        }
        return;
    }

    let mut current_parent = elidable_parent;
    if is_elidable_kind(language, node.kind()) && total_lines >= min_body_lines {
        let start_line = node_start_line(node) + 1;
        let end_line = node_end_line(node).saturating_sub(1);
        if start_line <= end_line {
            current_parent =
                Some(forest.push(elidable_parent, LineSpan { start: start_line, end: end_line }));
        }
    }

    // Detect consecutive runs of groupable siblings (e.g. import statements).
    let child_count = node.child_count();
    let mut run_first: Option<Node<'_>> = None;
    let mut run_last: Option<Node<'_>> = None;
    let mut run_count: u32 = 0;
    for index in 0..child_count {
        let Some(child) = node.child(index) else {
            continue;
        };
        if is_groupable_kind(language, child.kind()) {
            if run_first.is_none() {
                run_first = Some(child);
            }
            run_last = Some(child);
            run_count += 1;
        } else {
            flush_groupable_run(
                run_first,
                run_last,
                run_count,
                min_body_lines,
                forest,
                current_parent,
            );
            run_first = None;
            run_last = None;
            run_count = 0;
        }
    }
    flush_groupable_run(run_first, run_last, run_count, min_body_lines, forest, current_parent);

    for index in 0..child_count {
        if let Some(child) = node.child(index) {
            collect_elidable_tree(
                child,
                current_parent,
                language,
                min_body_lines,
                min_comment_lines,
                forest,
            );
        }
    }
}

fn flush_groupable_run(
    first: Option<Node<'_>>,
    last: Option<Node<'_>>,
    count: u32,
    min_body_lines: u32,
    forest: &mut ElidableForest,
    parent: Option<usize>,
) {
    if count < 2 {
        return;
    }
    let (Some(first), Some(last)) = (first, last) else {
        return;
    };
    let first_start = node_start_line(first);
    let last_start = node_start_line(last);
    let last_end = node_end_line(last);
    let span_lines = last_end.saturating_sub(first_start).saturating_add(1);
    if span_lines < min_body_lines {
        return;
    }
    let first_content_end = node_content_end_line(first).min(last_start.saturating_sub(1));
    let start = first_content_end.saturating_add(1);
    let end = last_start.saturating_sub(1);
    if start <= end {
        forest.push(parent, LineSpan { start, end });
    }
}

pub(crate) fn node_start_line(node: Node<'_>) -> u32 {
    node.start_position()
        .row
        .saturating_add(1)
        .min(u32::MAX as usize) as u32
}

fn node_end_line(node: Node<'_>) -> u32 {
    node.end_position()
        .row
        .saturating_add(1)
        .min(u32::MAX as usize) as u32
}

/// Last source line containing a content byte from `node`.
pub(crate) fn node_content_end_line(node: Node<'_>) -> u32 {
    let pos = node.end_position();
    let row = if pos.column == 0 && pos.row > 0 {
        pos.row - 1
    } else {
        pos.row
    };
    row.saturating_add(1).min(u32::MAX as usize) as u32
}

fn node_line_count(node: Node<'_>) -> u32 {
    node_end_line(node)
        .saturating_sub(node_start_line(node))
        .saturating_add(1)
}

fn is_comment_kind(language: SupportLang, kind: &str) -> bool {
    match language {
        #[cfg(feature = "lang-typescript")]
        SupportLang::TypeScript => kind == "comment",
        #[cfg(feature = "lang-javascript")]
        SupportLang::JavaScript => kind == "comment",
        #[cfg(feature = "lang-rust")]
        SupportLang::Rust => kind == "block_comment",
        #[cfg(feature = "lang-python")]
        SupportLang::Python => kind == "comment",
        #[cfg(feature = "lang-go")]
        SupportLang::Go => kind == "comment",
        #[cfg(feature = "lang-java")]
        SupportLang::Java => kind == "block_comment",
        #[cfg(feature = "lang-c")]
        SupportLang::C => kind == "comment",
        #[cfg(feature = "lang-cpp")]
        SupportLang::Cpp => kind == "comment",
        #[allow(unreachable_patterns)]
        _ => false,
    }
}

fn is_elidable_kind(language: SupportLang, kind: &str) -> bool {
    match language {
        #[cfg(feature = "lang-typescript")]
        SupportLang::TypeScript => matches!(
            kind,
            "statement_block"
                | "function_body"
                | "object"
                | "array"
                | "template_string"
                | "class_body"
                | "interface_body"
                | "enum_body"
                | "object_type"
                | "switch_body"
                | "jsx_element"
                | "jsx_self_closing_element"
        ),
        #[cfg(feature = "lang-javascript")]
        SupportLang::JavaScript => matches!(
            kind,
            "statement_block"
                | "function_body"
                | "object"
                | "array"
                | "template_string"
                | "class_body"
                | "interface_body"
                | "enum_body"
                | "object_type"
                | "switch_body"
                | "jsx_element"
                | "jsx_self_closing_element"
        ),
        #[cfg(feature = "lang-rust")]
        SupportLang::Rust => matches!(
            kind,
            "block"
                | "array_expression"
                | "tuple_expression"
                | "struct_expression"
                | "match_block"
                | "raw_string_literal"
                | "declaration_list"
                | "field_declaration_list"
                | "ordered_field_declaration_list"
                | "enum_variant_list"
                | "where_clause"
                | "use_list"
                | "macro_definition"
                | "token_tree"
        ),
        #[cfg(feature = "lang-python")]
        SupportLang::Python => matches!(
            kind,
            "block"
                | "dictionary"
                | "list" | "set"
                | "string"
                | "tuple"
                | "argument_list"
                | "parameters"
                | "parenthesized_expression"
                | "list_comprehension"
                | "set_comprehension"
                | "dictionary_comprehension"
                | "generator_expression"
                | "import_from_statement"
                | "subscript"
        ),
        #[cfg(feature = "lang-go")]
        SupportLang::Go => matches!(
            kind,
            "block"
                | "composite_literal"
                | "interpreted_string_literal"
                | "raw_string_literal"
                | "import_spec_list"
                | "const_declaration"
                | "var_declaration"
                | "field_declaration_list"
                | "interface_type"
                | "expression_switch_statement"
                | "type_switch_statement"
                | "select_statement"
        ),
        #[cfg(feature = "lang-java")]
        SupportLang::Java => matches!(
            kind,
            "block"
                | "array_initializer"
                | "class_body"
                | "interface_body"
                | "enum_body"
                | "annotation_type_body"
                | "constructor_body"
                | "switch_block"
                | "string_literal"
        ),
        #[cfg(feature = "lang-c")]
        SupportLang::C => matches!(
            kind,
            "compound_statement"
                | "initializer_list"
                | "string_literal"
                | "field_declaration_list"
                | "enumerator_list"
                | "concatenated_string"
        ),
        #[cfg(feature = "lang-cpp")]
        SupportLang::Cpp => matches!(
            kind,
            "compound_statement"
                | "initializer_list"
                | "string_literal"
                | "field_declaration_list"
                | "enumerator_list"
                | "concatenated_string"
                | "declaration_list"
                | "raw_string_literal"
                | "requires_clause"
        ),
        #[cfg(feature = "lang-bash")]
        SupportLang::Bash => matches!(
            kind,
            "compound_statement"
                | "if_statement"
                | "case_statement"
                | "do_group"
                | "subshell"
                | "array"
                | "heredoc_body"
        ),
        #[cfg(feature = "lang-html")]
        SupportLang::Html => matches!(kind, "element" | "script_element" | "style_element"),
        #[cfg(feature = "lang-css")]
        SupportLang::Css => matches!(kind, "block" | "keyframe_block_list"),
        #[cfg(feature = "lang-json")]
        SupportLang::Json => matches!(kind, "object" | "array"),
        #[cfg(feature = "lang-markdown")]
        SupportLang::Markdown => matches!(kind, "fenced_code_block" | "pipe_table" | "list"),
        // Skip: data formats with no closing-token anchor (Yaml mappings,
        // Toml tables). Eliding these deletes the only content worth reading.
        #[cfg(feature = "lang-yaml")]
        SupportLang::Yaml => false,
        #[cfg(feature = "lang-toml")]
        SupportLang::Toml => false,
        #[allow(unreachable_patterns)]
        _ => false,
    }
}

fn is_groupable_kind(language: SupportLang, kind: &str) -> bool {
    match language {
        #[cfg(feature = "lang-typescript")]
        SupportLang::TypeScript => kind == "import_statement",
        #[cfg(feature = "lang-javascript")]
        SupportLang::JavaScript => kind == "import_statement",
        #[cfg(feature = "lang-rust")]
        SupportLang::Rust => matches!(kind, "use_declaration" | "extern_crate_declaration"),
        #[cfg(feature = "lang-python")]
        SupportLang::Python => {
            matches!(kind, "import_statement" | "import_from_statement" | "future_import_statement")
        }
        #[cfg(feature = "lang-go")]
        SupportLang::Go => kind == "import_declaration",
        #[cfg(feature = "lang-java")]
        SupportLang::Java => kind == "import_declaration",
        #[cfg(feature = "lang-c")]
        SupportLang::C => kind == "preproc_include",
        #[cfg(feature = "lang-cpp")]
        SupportLang::Cpp => kind == "preproc_include",
        #[allow(unreachable_patterns)]
        _ => false,
    }
}

fn normalize_spans(mut spans: Vec<LineSpan>, total_lines: u32) -> Vec<LineSpan> {
    if total_lines == 0 {
        return Vec::new();
    }
    spans.retain(|span| span.start <= span.end && span.start <= total_lines);
    for span in &mut spans {
        span.end = span.end.min(total_lines);
    }
    spans.sort_by_key(|span| (span.start, span.end));
    let mut merged: Vec<LineSpan> = Vec::new();
    for span in spans {
        if let Some(last) = merged.last_mut() {
            if span.start <= last.end.saturating_add(1) {
                last.end = last.end.max(span.end);
                continue;
            }
        }
        merged.push(span);
    }
    merged
}

fn build_segments(source: &str, total_lines: u32, spans: &[LineSpan]) -> Vec<SummarySegment> {
    if total_lines == 0 {
        return Vec::new();
    }
    let source_lines: Vec<&str> = source.lines().collect();
    let elided_lines = spans
        .iter()
        .flat_map(|span| span.start..=span.end)
        .collect::<BTreeSet<u32>>();
    let mut segments = Vec::new();
    let mut current_kind: Option<&str> = None;
    let mut current_start = 1;
    let mut current_lines: Vec<&str> = Vec::new();

    for line_number in 1..=total_lines {
        let is_elided = elided_lines.contains(&line_number);
        let kind = if is_elided { "elided" } else { "kept" };
        if current_kind.is_some_and(|existing| existing != kind) {
            push_segment(
                &mut segments,
                current_kind.expect("kind set"),
                current_start,
                line_number - 1,
                &current_lines,
            );
            current_start = line_number;
            current_lines.clear();
        }
        current_kind = Some(kind);
        if !is_elided {
            let index = line_number.saturating_sub(1) as usize;
            current_lines.push(source_lines.get(index).copied().unwrap_or_default());
        }
    }
    if let Some(kind) = current_kind {
        push_segment(&mut segments, kind, current_start, total_lines, &current_lines);
    }
    segments
}

fn push_segment(
    segments: &mut Vec<SummarySegment>,
    kind: &str,
    start_line: u32,
    end_line: u32,
    lines: &[&str],
) {
    segments.push(SummarySegment {
        kind: kind.to_string(),
        start_line,
        end_line,
        text: (kind == "kept").then(|| lines.join("\n")),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summarize(code: &str, path: &str) -> SummaryResult {
        summarize_code(SummaryOptions {
            code: code.to_string(),
            lang: None,
            path: Some(path.to_string()),
            min_body_lines: None,
            min_comment_lines: None,
            unfold_until_lines: None,
            unfold_limit_lines: None,
        })
        .expect("summary succeeds")
    }

    fn segment_kinds(result: &SummaryResult) -> Vec<&str> {
        result
            .segments
            .iter()
            .map(|segment| segment.kind.as_str())
            .collect()
    }

    #[test]
    fn summarizes_typescript_function_body() {
        let result = summarize(
            "export function greet(name: string): string {\n\tconst clean = name.trim();\nconst \
             label = clean || 'world';\nreturn `hello ${label}`;\n}\n",
            "fixture.ts",
        );
        assert!(result.parsed);
        assert!(result.elided);
        assert_eq!(result.language.as_deref(), Some("typescript"));
        assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
        assert_eq!(
            result.segments[0].text.as_deref(),
            Some("export function greet(name: string): string {")
        );
        assert_eq!(result.segments[1].start_line, 2);
        assert_eq!(result.segments[1].end_line, 4);
        assert_eq!(result.segments[2].text.as_deref(), Some("}"));
    }

    #[test]
    fn summarizes_rust_method_body_but_keeps_impl_boundaries() {
        let result = summarize(
            "struct Greeter;\n\nimpl Greeter {\n\tfn greet(&self) -> String \
             {\n\t\tlet name = \"world\";\n\t\tlet label = \
             name.to_uppercase();\n\t\tformat!(\"hello {label}\")\n\t}\n}\n",
            "fixture.rs",
        );
        assert!(result.parsed);
        assert!(result.elided);
        let rendered = result
            .segments
            .iter()
            .map(|segment| {
                segment
                    .text
                    .clone()
                    .unwrap_or_else(|| "...".to_string())
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("impl Greeter {\n...\n}"));
    }

    #[test]
    fn summarizes_python_function_body() {
        let result = summarize(
            "class Greeter:\n    def greet(self, name: str) -> str:\n        clean = \
             name.strip()\n        label = clean or 'world'\n        return f'hello \
             {label}'\n",
            "fixture.py",
        );
        assert!(result.parsed);
        assert!(result.elided);
        assert_eq!(segment_kinds(&result), vec!["kept", "elided", "kept"]);
        assert!(result.segments[0]
            .text
            .as_deref()
            .unwrap_or_default()
            .contains("def greet"));
        assert!(result.segments[2]
            .text
            .as_deref()
            .unwrap_or_default()
            .contains("return"));
    }

    #[test]
    fn min_body_lines_controls_short_body_elision() {
        let code = "function small() {\n\treturn 1;\n}\n";
        let default_result = summarize(code, "fixture.ts");
        assert!(default_result.parsed);
        assert!(!default_result.elided);
        let override_result = summarize_code(SummaryOptions {
            code: code.to_string(),
            lang: Some("typescript".to_string()),
            path: None,
            min_body_lines: Some(3),
            min_comment_lines: None,
            unfold_until_lines: None,
            unfold_limit_lines: None,
        })
        .expect("summary succeeds");
        assert!(override_result.elided);
    }

    #[test]
    fn parse_failure_falls_back_to_unparsed() {
        let result = summarize("export function broken( {\n", "fixture.ts");
        assert!(!result.parsed);
        assert!(!result.elided);
        assert_eq!(result.segments.len(), 1);
    }

    #[test]
    fn unsupported_language_is_unparsed() {
        let result = summarize("plain text\nwith lines\n", "fixture.txt");
        assert!(!result.parsed);
        assert_eq!(
            result.segments[0].text.as_deref(),
            Some("plain text\nwith lines\n")
        );
    }

    #[test]
    fn summarizes_rust_use_run() {
        let code = "use std::fs;\nuse std::path::Path;\nuse \
                    std::collections::HashMap;\nuse std::sync::Arc;\nuse \
                    std::io;\n\nfn main() {}\n";
        let result = summarize(code, "fixture.rs");
        assert!(result.parsed);
        assert!(result.elided);
        let elided = result
            .segments
            .iter()
            .find(|seg| seg.kind == "elided")
            .expect("elided segment");
        assert_eq!(elided.start_line, 2);
        assert_eq!(elided.end_line, 4);
    }

    fn summarize_with_unfold(code: &str, path: &str, until: u32, limit: u32) -> SummaryResult {
        summarize_code(SummaryOptions {
            code: code.to_string(),
            lang: None,
            path: Some(path.to_string()),
            min_body_lines: None,
            min_comment_lines: None,
            unfold_until_lines: Some(until),
            unfold_limit_lines: Some(limit),
        })
        .expect("summary succeeds")
    }

    #[test]
    fn bfs_unfold_reveals_nested_json_when_root_collapses() {
        let body = (0..30)
            .map(|i| format!("\t\"key{i}\": {i}"))
            .collect::<Vec<_>>()
            .join(",\n");
        let nested = "\t\"deps\": {\n\t\t\"a\": 1,\n\t\t\"b\": 2,\n\t\t\"c\": 3,\n\t\t\"d\": 4\n\t}";
        let code = format!("{{\n{body},\n{nested}\n}}\n");

        let legacy = summarize_with_unfold(&code, "pkg.json", 0, 0);
        assert!(legacy.elided);
        let legacy_kept_lines: u32 = legacy
            .segments
            .iter()
            .filter(|s| s.kind == "kept")
            .map(|s| s.end_line - s.start_line + 1)
            .sum();
        assert_eq!(legacy_kept_lines, 2);

        let unfolded = summarize_with_unfold(&code, "pkg.json", 20, 100);
        assert!(unfolded.elided, "deps body should remain elided");
        let kept_text = unfolded
            .segments
            .iter()
            .filter(|s| s.kind == "kept")
            .filter_map(|s| s.text.as_deref())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(kept_text.contains("\"key0\""));
        assert!(kept_text.contains("\"key29\""));
        assert!(kept_text.contains("\"deps\""));
        assert!(!kept_text.contains("\"a\": 1"));
    }
}
