/**
 * Edit 工具结果渲染器 — Diff 视图
 *
 * 显示 old_string → new_string 的差异：
 * 删除行红色背景，新增行绿色背景
 */
import * as React from "react";
import { cn } from "@/lib/utils";

interface EditResultRendererProps {
  result: string;
  isError: boolean;
  input: Record<string, unknown>;
}

export function EditResultRenderer({ result, isError, input }: EditResultRendererProps): React.ReactElement {
  const oldStr = typeof input.old_string === "string" ? input.old_string : "";
  const newStr = typeof input.new_string === "string" ? input.new_string : "";

  if (isError) {
    return (
      <pre className="overflow-x-auto rounded-md bg-destructive/5 p-3 font-mono text-[12px] text-destructive/80 whitespace-pre-wrap break-all">
        {result}
      </pre>
    );
  }

  if (!oldStr && !newStr) {
    return <div className="text-[12px] text-muted-foreground">{result || "编辑成功"}</div>;
  }

  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  return (
    <div className="overflow-x-auto rounded-md bg-zinc-900 font-mono text-[12px] leading-relaxed dark:bg-zinc-950">
      {oldStr && oldLines.length > 0 && (
        <div>
          {oldLines.map((line, i) => (
            <div key={`del-${i}`} className="flex bg-red-500/10">
              <span className="w-10 shrink-0 select-none pr-3 text-right text-[11px] text-red-400/60">-</span>
              <span className={cn("flex-1 whitespace-pre-wrap break-all text-red-300")}>{line || "\u200B"}</span>
            </div>
          ))}
        </div>
      )}
      {newStr && newLines.length > 0 && (
        <div>
          {newLines.map((line, i) => (
            <div key={`add-${i}`} className="flex bg-green-500/10">
              <span className="w-10 shrink-0 select-none pr-3 text-right text-[11px] text-green-400/60">+</span>
              <span className={cn("flex-1 whitespace-pre-wrap break-all text-green-300")}>{line || "\u200B"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
