//! BPE token counting via tiktoken-rs.
//! Adapted from oh-my-pi pi-natives/src/tokens.rs
//! License: MIT — © 2025 Mario Zechner, © 2025-2026 Can Bölük

use std::sync::LazyLock;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use tiktoken_rs::{cl100k_base, o200k_base, CoreBPE};

static CL100K_BASE: LazyLock<CoreBPE> =
    LazyLock::new(|| cl100k_base().unwrap_or_else(|_| o200k_base().unwrap()));
static O200K_BASE: LazyLock<CoreBPE> =
    LazyLock::new(|| o200k_base().unwrap_or_else(|_| cl100k_base().unwrap()));

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
    let bpe = if use_cl100k {
        &*CL100K_BASE
    } else {
        &*O200K_BASE
    };
    bpe.encode_ordinary(text).len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_string_count_is_stable() {
        let first = count_tokens(TokenCountInput {
            text: Either::A("hello world".to_string()),
            model: None,
        })
        .expect("token count succeeds")
        .count;
        let second = count_tokens(TokenCountInput {
            text: Either::A("hello world".to_string()),
            model: None,
        })
        .expect("token count succeeds")
        .count;

        assert_eq!(first, second);
        assert!(first > 0.0);
    }

    #[test]
    fn counts_string_arrays() {
        let single = count_tokens(TokenCountInput {
            text: Either::A("hello".to_string()),
            model: None,
        })
        .expect("single token count succeeds")
        .count;
        let array = count_tokens(TokenCountInput {
            text: Either::B(vec!["hello".to_string(), "hello".to_string()]),
            model: None,
        })
        .expect("array token count succeeds")
        .count;

        assert_eq!(array, single * 2.0);
    }
}
