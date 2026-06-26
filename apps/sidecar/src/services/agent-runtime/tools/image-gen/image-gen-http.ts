import { readFile } from "node:fs/promises";
import type { ImageGenMode, ImageProviderProfile } from "./image-provider-profiles";

export interface ImageHttpInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: ImageGenMode;
  prompt: string;
  size?: string;
  profile: ImageProviderProfile;
  referenceImageAbsPath?: string;
  maskImageAbsPath?: string;
  abortSignal?: AbortSignal;
}

export interface ImageHttpSuccess {
  ok: true;
  url?: string;
  b64?: string;
  ext: string;
}

function joinImageUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${suffix}`;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

/** 调用 OpenAI 兼容图像接口。成功返回图片数据，失败抛错（由 core 层捕获做回退） */
export async function callImageHttp(input: ImageHttpInput): Promise<ImageHttpSuccess> {
  const endpoint = input.mode === "text-to-image" ? "/images/generations" : "/images/edits";
  const url = joinImageUrl(input.baseUrl, endpoint);
  const headers: Record<string, string> = { Authorization: `Bearer ${input.apiKey}` };

  let response: Response;
  if (input.mode === "text-to-image") {
    headers["Content-Type"] = "application/json";
    const body: Record<string, unknown> = {
      model: input.model,
      prompt: input.prompt,
      response_format: input.profile.responseFormat,
      ...input.profile.extraBody,
    };
    const mappedSize = input.profile.mapSize?.(input.size);
    if (mappedSize) body.size = mappedSize;
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: input.abortSignal,
    });
  } else {
    if (!input.referenceImageAbsPath) {
      throw new Error("图生图/编辑模式缺少 referenceImageAbsPath");
    }
    const form = new FormData();
    const imageField = input.profile.editImageField ?? "image";
    const maskField = input.profile.editMaskField ?? "mask";
    form.append("model", input.model);
    form.append("prompt", input.prompt);
    form.append("response_format", input.profile.responseFormat);
    const mappedSize = input.profile.mapSize?.(input.size);
    if (mappedSize) form.append("size", mappedSize);
    form.append(
      imageField,
      new Blob([await readFile(input.referenceImageAbsPath)]),
      "reference.png",
    );
    if (input.maskImageAbsPath) {
      form.append(
        maskField,
        new Blob([await readFile(input.maskImageAbsPath)]),
        "mask.png",
      );
    }
    for (const [k, v] of Object.entries(input.profile.extraFormFields ?? {})) {
      form.append(k, v);
    }
    response = await fetch(url, { method: "POST", headers, body: form, signal: input.abortSignal });
  }

  if (!response.ok) {
    const text = await safeReadText(response);
    throw new Error(`图像生成请求失败 ${response.status}: ${text}`);
  }

  const json = (await response.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
  const item = json.data?.[0];
  if (!item) {
    throw new Error("图像生成响应缺少 data");
  }
  if (item.b64_json) return { ok: true, b64: item.b64_json, ext: "png" };
  if (item.url) return { ok: true, url: item.url, ext: "png" };
  throw new Error("图像生成响应缺少图片数据");
}
