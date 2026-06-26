import type { ProviderType } from "@lume/shared";

export type ImageGenMode = "text-to-image" | "image-to-image" | "edit";
export type ImageResponseFormat = "url" | "b64_json";

export interface ImageProviderProfile {
  /** 请求 response_format 与响应解析依据 */
  responseFormat: ImageResponseFormat;
  /** 把通用 size（1:1/16:9/像素）映射为 provider 支持尺寸；返回 undefined 表示不发送 size */
  mapSize?: (size?: string) => string | undefined;
  /** 文生图 JSON body 的 provider 特有参数（原始类型） */
  extraBody?: Record<string, unknown>;
  /** 编辑 multipart 的 provider 特有字段（字符串值） */
  extraFormFields?: Record<string, string>;
  /** 编辑模式参考图字段名，默认 "image" */
  editImageField?: string;
  /** 编辑模式蒙版字段名，默认 "mask" */
  editMaskField?: string;
}

const DEFAULT_SIZE_MAP: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "3:4": "1024x1536",
  "4:3": "1536x1024",
};

function defaultMapSize(size?: string): string | undefined {
  if (!size) return undefined;
  return DEFAULT_SIZE_MAP[size] ?? size;
}

const OPENAI_PROFILE: ImageProviderProfile = {
  responseFormat: "b64_json",
  mapSize: defaultMapSize,
};

const DOUBAO_PROFILE: ImageProviderProfile = {
  responseFormat: "url",
  mapSize: defaultMapSize,
};

const STEPFUN_PROFILE: ImageProviderProfile = {
  responseFormat: "b64_json",
  mapSize: defaultMapSize,
  extraBody: { steps: 8, cfg_scale: 1.0, text_mode: true },
  extraFormFields: { steps: "8", cfg_scale: "1.0", text_mode: "true" },
};

const PROFILE_BY_PROVIDER: Partial<Record<ProviderType, ImageProviderProfile>> = {
  openai: OPENAI_PROFILE,
  doubao: DOUBAO_PROFILE,
  stepfun: STEPFUN_PROFILE,
  "stepfun-coding-plan": STEPFUN_PROFILE,
};

/** 按 provider 取 profile；未知 provider 回退到 OpenAI 默认 */
export function resolveImageProviderProfile(provider: ProviderType): ImageProviderProfile {
  return PROFILE_BY_PROVIDER[provider] ?? OPENAI_PROFILE;
}
