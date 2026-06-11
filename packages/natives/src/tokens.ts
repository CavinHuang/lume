/**
 * Token counting via native Rust (tiktoken-rs).
 */

export interface TokenCountInput {
  text: string | string[];
  model?: string;
}

export interface TokenCountResult {
  count: number;
}
