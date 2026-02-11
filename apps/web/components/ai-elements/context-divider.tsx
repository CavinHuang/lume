"use client";

type ContextDividerProps = {
  label?: string;
};

export function ContextDivider({ label = "Context Divider" }: ContextDividerProps): React.ReactElement {
  return (
    <div className="my-1 flex items-center gap-2">
      <span className="h-px flex-1 bg-slate-700" />
      <span className="rounded-full border border-dashed border-slate-700 bg-slate-950 px-2.5 py-0.5 text-xs text-slate-400">{label}</span>
      <span className="h-px flex-1 bg-slate-700" />
    </div>
  );
}
