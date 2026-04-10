/**
 * ToolResultRenderer — 工具结果分发渲染器
 *
 * 根据工具名称分发到对应的专属渲染器，
 * 未匹配时使用 DefaultResultRenderer。
 */
import * as React from "react";
import { resolveToolResultRenderer } from "./registry";
import type { ToolResultRendererProps } from "./types";

export type { ToolResultRendererProps } from "./types";

export function ToolResultRenderer({ toolName, input, result, isError }: ToolResultRendererProps): React.ReactElement {
  const Renderer = resolveToolResultRenderer(toolName);
  return <Renderer result={result} isError={isError} input={input} />;
}

export { CollapsibleResult } from "./collapsible-result";
