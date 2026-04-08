export type Api =
  | "anthropic-messages"
  | "google-generative-ai"
  | "openai-responses";

export type KnownProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "opencode"
  | "google"
  | "zai"
  | "minimax"
  | "minimax-cn"
  | "kimi-coding";

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  provider: KnownProvider;
  api: TApi;
  reasoning?: boolean;
  baseUrl?: string;
  input: string[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
}
