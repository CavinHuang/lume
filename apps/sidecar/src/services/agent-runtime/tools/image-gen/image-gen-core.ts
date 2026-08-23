import type { Channel, ProviderType } from "@lume/shared";
import { getRuntimeHostPorts } from "../../host-ports";
import { getEffectiveLumeConfig } from "../../../system/lume-config-service";
import { createLogger } from "../../../infra/logger";
import { callImageHttp } from "./image-gen-http";
import { saveImageOutput } from "./image-gen-output";
import { resolveImageProviderProfile, type ImageGenMode } from "./image-provider-profiles";

const log = createLogger("image-gen");

export interface ImageGenImage {
  threadPath: string;
  filename: string;
  mediaType: string;
  size: number;
}

export interface ImageGenResult {
  images: ImageGenImage[];
  modelUsed: string;
  mode: ImageGenMode;
}

export interface ImageGenParams {
  workspaceSlug?: string;
  threadId: string;
  prompt: string;
  size?: string;
  referenceImage?: string;
  maskImage?: string;
  model?: string;
  filesRoot?: string;
  abortSignal?: AbortSignal;
}

export interface ImageGenDeps {
  resolveBinding: (modelRef: string) => { channel: Channel; modelId: string } | null;
  decryptKey: (channelId: string) => string;
  callHttp: typeof callImageHttp;
  readModelRefs: (workspaceSlug?: string) => string[];
  resolveRef: (workspaceSlug: string | undefined, threadId: string, threadPath: string) => string;
  saveOutput: typeof saveImageOutput;
}

const defaultDeps: ImageGenDeps = {
  resolveBinding: (modelRef) => {
    const binding = getRuntimeHostPorts().resolveChannelModelBinding(modelRef);
    return binding ? { channel: binding.channel, modelId: binding.modelId } : null;
  },
  decryptKey: (channelId) => getRuntimeHostPorts().decryptApiKey(channelId),
  callHttp: callImageHttp,
  readModelRefs: (ws) =>
    getEffectiveLumeConfig(ws).models?.imageGeneration?.priorityModelRefs ?? [],
  resolveRef: (...args) => getRuntimeHostPorts().resolveThreadAttachmentPath(...args),
  saveOutput: saveImageOutput,
};

function resolveMode(referenceImage?: string, maskImage?: string): ImageGenMode {
  if (referenceImage && maskImage) return "edit";
  if (referenceImage) return "image-to-image";
  return "text-to-image";
}

/** 按优先级尝试生成；成功即返回，全部失败抛聚合错误 */
export async function generateImage(
  params: ImageGenParams,
  deps: ImageGenDeps = defaultDeps,
): Promise<ImageGenResult> {
  const mode = resolveMode(params.referenceImage, params.maskImage);

  const refs = deps.readModelRefs(params.workspaceSlug);
  if (refs.length === 0) {
    throw new Error("未配置图像生成模型（请在设置中配置 models.imageGeneration.priorityModelRefs）");
  }

  const ordered = params.model
    ? Array.from(new Set([params.model, ...refs]))
    : refs;

  let referenceAbsPath: string | undefined;
  let maskAbsPath: string | undefined;
  if (params.referenceImage) {
    referenceAbsPath = deps.resolveRef(params.workspaceSlug, params.threadId, params.referenceImage);
  }
  if (params.maskImage) {
    maskAbsPath = deps.resolveRef(params.workspaceSlug, params.threadId, params.maskImage);
  }

  const failures: Array<{ modelRef: string; error: string }> = [];
  for (const modelRef of ordered) {
    const binding = deps.resolveBinding(modelRef);
    if (!binding) {
      failures.push({ modelRef, error: "渠道未配置或未启用" });
      continue;
    }
    const apiKey = deps.decryptKey(binding.channel.id);
    const provider = (binding.channel.providerId ?? binding.channel.provider) as ProviderType;
    const profile = resolveImageProviderProfile(provider);
    try {
      const httpResult = await deps.callHttp({
        baseUrl: binding.channel.baseUrl,
        apiKey,
        model: binding.modelId,
        mode,
        prompt: params.prompt,
        size: params.size,
        profile,
        referenceImageAbsPath: referenceAbsPath,
        maskImageAbsPath: maskAbsPath,
        abortSignal: params.abortSignal,
      });
      const saved = await deps.saveOutput({
        workspaceSlug: params.workspaceSlug,
        threadId: params.threadId,
        url: httpResult.url,
        b64: httpResult.b64,
        ext: httpResult.ext,
        filesRoot: params.filesRoot,
        abortSignal: params.abortSignal,
      });
      log.info("图像生成成功", { modelRef, mode, threadPath: saved.threadPath });
      return {
        images: [{
          threadPath: saved.threadPath,
          filename: saved.filename,
          mediaType: saved.mediaType,
          size: saved.size,
          ...(saved.fileRef ? { fileRef: saved.fileRef } : {}),
        }],
        modelUsed: modelRef,
        mode,
      };
    } catch (error) {
      if (params.abortSignal?.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.warn("图像生成失败，尝试下一个模型", { modelRef, message });
      failures.push({ modelRef, error: message });
    }
  }

  const detail = failures.map((f) => `${f.modelRef}: ${f.error}`).join("; ");
  throw new Error(`所有图像生成模型均失败 — ${detail}`);
}
