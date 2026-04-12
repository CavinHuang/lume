import * as React from "react";
import { CheckCircle2, Files, FolderUp, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PromotionCandidate {
  name: string;
  path: string;
  status: "suggested" | "promoted";
}

export function FilePromotionCard({
  files,
  onPromote,
  onPromoteAll,
  onDismiss
}: {
  files: PromotionCandidate[];
  onPromote: (file: PromotionCandidate) => void;
  onPromoteAll: () => void;
  onDismiss: () => void;
}): React.ReactElement | null {
  if (files.length === 0) return null;

  const suggested = files.filter((file) => file.status === "suggested");

  return (
    <div className="my-2 max-w-[630px]">
      <div className="rounded-lg border border-border/60 bg-muted/25 px-3.5 py-3">
        <div className="mb-1.5 flex items-center gap-1.5">
          <FolderUp className="size-3.5 text-muted-foreground" />
          <span className="text-[13px] font-medium text-foreground/75">这些文件可能值得沉淀到工作区共享文件</span>
          <button
            type="button"
            onClick={onDismiss}
            className="ml-auto rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
          当前任务文件默认仅属于本次任务。若后续任务还会继续使用，可以提升到工作区共享文件。
        </p>

        <div className="space-y-1.5">
          {files.map((file) => (
            <div
              key={file.path}
              className="flex items-center gap-2 rounded-md border border-border/50 bg-background/55 px-3 py-2"
            >
              <Files className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px]">{file.name}</span>
              {file.status === "promoted" ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-green-600">
                  <CheckCircle2 className="size-3.5" />
                  已提升
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onPromote(file)}
                  className={cn(
                    "rounded-md border border-border/60 px-2 py-1 text-[11px] transition-colors",
                    "hover:bg-muted"
                  )}
                >
                  提升
                </button>
              )}
            </div>
          ))}
        </div>

        {suggested.length > 1 ? (
          <div className="mt-3 flex items-center justify-end">
            <button
              type="button"
              onClick={onPromoteAll}
              className="rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              全部提升
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
