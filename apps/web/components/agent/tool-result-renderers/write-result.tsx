/**
 * Write 工具结果渲染器 — 简洁成功消息
 */
import * as React from "react";
import { ErrorResult } from "./shared";
import type { ToolResultContentProps } from "./types";

export function WriteResultRenderer({ result, isError, input }: ToolResultContentProps): React.ReactElement {
  if (isError) {
    return <ErrorResult result={result} />;
  }

  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  const filename = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  const content = typeof input.content === "string" ? input.content : "";
  const lineCount = content ? content.split("\n").length : 0;

  return (
    <div className="text-[12px] text-muted-foreground">
      已写入{" "}
      <span className="font-mono text-foreground/70">{filename || "文件"}</span>
      {lineCount > 0 && <span>，{lineCount} 行</span>}
    </div>
  );
}
