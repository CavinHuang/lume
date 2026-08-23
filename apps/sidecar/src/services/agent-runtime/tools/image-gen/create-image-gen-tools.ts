import type { ToolDefinition } from "@lume/agent-sdk";
import { channelStore } from "../../agent-channel-store-holder";
import { getEffectiveLumeConfig } from "../../../system/lume-config-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";
import { generateImage } from "./image-gen-core";

export interface CreateImageGenToolsInput {
  threadId: string;
  workspaceSlug?: string;
  filesRoot?: string;
}

export function createImageGenTools(input: CreateImageGenToolsInput): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "image_gen",
      description: `Generate an image from a text prompt, or transform/edit a reference image. The model is chosen automatically from the configured image-generation priority list, with automatic fallback on failure.

Modes (decided by which inputs you provide):
- text-to-image: prompt only (+ optional size)
- image-to-image: prompt + reference_image
- edit/inpaint: prompt + reference_image + mask_image

reference_image and mask_image accept a threadPath (relative to the current thread). The generated image is saved to the current thread; the returned threadPath can be referenced in your reply so the user can preview it.`,
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Image generation prompt. English recommended.", minLength: 1 },
          size: { type: "string", description: 'Size or aspect ratio, e.g. "1024x1024", "1:1", "16:9". Optional.' },
          reference_image: { type: "string", description: "threadPath of a reference image for image-to-image or edit." },
          mask_image: { type: "string", description: "threadPath of a mask marking the region to repaint. Requires reference_image." },
          model: { type: "string", description: "Optional explicit modelRef overriding the automatic priority list." },
        },
        required: ["prompt"],
      },
      async call(args, ctx) {
        const workspaceSlug = input.workspaceSlug;
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) {
          throw new Error("prompt 必填");
        }
        const referenceImage = typeof args.reference_image === "string" && args.reference_image.trim() ? args.reference_image.trim() : undefined;
        const maskImage = typeof args.mask_image === "string" && args.mask_image.trim() ? args.mask_image.trim() : undefined;
        if (maskImage && !referenceImage) {
          throw new Error("mask_image 必须与 reference_image 同时提供");
        }
        const size = typeof args.size === "string" && args.size.trim() ? args.size.trim() : undefined;
        const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;

        return generateImage({
          workspaceSlug,
          threadId: input.threadId,
          prompt,
          size,
          referenceImage,
          maskImage,
          model,
          filesRoot: input.filesRoot,
          abortSignal: ctx.abortSignal,
        });
      },
    }),
    createSdkJsonResultTool({
      name: "list_image_models",
      description: "List the configured image-generation models with their availability. Use this to tell the user which image models are available, or to pick a specific model for image_gen.",
      inputSchema: { type: "object", properties: {} },
      isReadOnly: true,
      async call() {
        const config = getEffectiveLumeConfig(input.workspaceSlug);
        const refs = config.models?.imageGeneration?.priorityModelRefs ?? [];
        const models = refs.map((modelRef, index) => {
          const binding = channelStore().resolveModelBinding(modelRef);
          if (!binding) {
            return { modelRef, provider: null, modelId: null, available: false, reason: "渠道未配置或未启用", priority: index + 1 };
          }
          return {
            modelRef,
            provider: binding.channel.providerId ?? binding.channel.provider,
            modelId: binding.modelId,
            available: true,
            priority: index + 1,
          };
        });
        return { models };
      },
    }),
  ];
}
