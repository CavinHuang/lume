import type { ComponentType } from "react";
import { BashResultRenderer } from "./bash-result";
import { DefaultResultRenderer } from "./default-result";
import { EditResultRenderer } from "./edit-result";
import { GlobResultRenderer } from "./glob-result";
import { GrepResultRenderer } from "./grep-result";
import { ReadResultRenderer } from "./read-result";
import type { ToolResultContentProps } from "./types";
import { WebFetchResultRenderer } from "./web-fetch-result";
import { WebSearchResultRenderer } from "./web-search-result";
import { WriteResultRenderer } from "./write-result";

const TOOL_RENDERERS: Record<string, ComponentType<ToolResultContentProps>> = {
  bash: BashResultRenderer,
  read: ReadResultRenderer,
  edit: EditResultRenderer,
  multiedit: EditResultRenderer,
  write: WriteResultRenderer,
  grep: GrepResultRenderer,
  glob: GlobResultRenderer,
  websearch: WebSearchResultRenderer,
  webfetch: WebFetchResultRenderer,
};

export function resolveToolResultRenderer(toolName: string): ComponentType<ToolResultContentProps> {
  const normalized = toolName.trim().toLowerCase();
  return TOOL_RENDERERS[normalized] ?? DefaultResultRenderer;
}

