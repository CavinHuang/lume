"use client";

type DeleteMessageDialogProps = {
  open: boolean;
  title?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function DeleteMessageDialog({
  open,
  title = "确认删除该消息？",
  onConfirm,
  onCancel
}: DeleteMessageDialogProps): React.ReactElement | null {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65">
      <div className="flex min-w-[280px] max-w-[90vw] flex-col gap-2.5 rounded-xl border border-slate-700 bg-slate-900 p-3.5">
        <p>{title}</p>
        <div className="flex gap-1.5">
          <button type="button" className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm hover:bg-slate-700" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="rounded-md border border-red-900 bg-red-950/30 px-3 py-1.5 text-sm text-red-300 hover:bg-red-900/40" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
