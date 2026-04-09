/**
 * Write 工具结果渲染器 — 简洁成功消息
 */
import * as React from "react";

interface WriteResultRendererProps {
  result: string;
  isError: boolean;
  input: Record<string, unknown>;
}

export function WriteResultRenderer({ result, isError, input }: WriteResultRendererProps): React.ReactElement {
  if (isError) {
    return (
      <pre className="overflow-x-auto rounded-md bg-destructive/5 p-3 font-mono text-[12px] text-destructive/80 whitespace-pre-wrap break-all">
        {result}
      </pre>
    );
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
