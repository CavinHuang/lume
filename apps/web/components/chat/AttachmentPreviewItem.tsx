"use client";

type AttachmentPreviewItemProps = {
  filename: string;
  size?: number;
  onRemove?: () => void;
};

export function AttachmentPreviewItem({
  filename,
  size,
  onRemove
}: AttachmentPreviewItemProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-700 px-3 py-2">
      <span>{filename}</span>
      <div className="flex items-center gap-1.5">
        {typeof size === "number" ? <span className="text-xs text-muted-foreground">{size}B</span> : null}
        {onRemove ? (
          <button type="button" className="rounded border border-red-900 bg-red-950/30 px-2 py-1 text-xs text-red-300 hover:bg-red-900/40" onClick={onRemove}>
            Remove
          </button>
        ) : null}
      </div>
    </div>
  );
}
