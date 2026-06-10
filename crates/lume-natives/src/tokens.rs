//! BPE token counting via tiktoken-rs.
//! Adapted from oh-my-pi pi-natives/src/tokens.rs
//! License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use tiktoken_rs::{cl100k_base, o200k_base, CoreBPE};

#[napi(object)]
pub struct TokenCountInput {
    pub text: Either<String, Vec<String>>,
    pub model: Option<String>,
}

#[napi(object)]
pub struct TokenCountResult {
    pub count: f64,
}

/// Count BPE tokens for text. Uses O200kBase (GPT-4o) by default,
/// or Cl100kBase for older models.
#[napi]
pub fn count_tokens(input: TokenCountInput) -> Result<TokenCountResult> {
    let use_cl100k = matches!(
        input.model.as_deref(),
        Some(m) if m.contains("gpt-3.5") || m.contains("gpt-4-")
    );

    let count = match input.text {
        Either::A(text) => count_single(&text, use_cl100k),
        Either::B(texts) => texts.par_iter().map(|t| count_single(t, use_cl100k)).sum(),
    };

    Ok(TokenCountResult {
        count: count as f64,
    })
}

fn count_single(text: &str, use_cl100k: bool) -> usize {
    let bpe: CoreBPE = if use_cl100k {
        cl100k_base().unwrap_or_else(|_| o200k_base().unwrap())
    } else {
        o200k_base().unwrap_or_else(|_| cl100k_base().unwrap())
    };
    bpe.encode_ordinary(text).len()
}
