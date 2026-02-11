"use client";

type ReasoningProps = {
  content: string;
};

export function ReasoningBlock({ content }: ReasoningProps): React.ReactElement {
  return (
    <details className="rounded-md border border-dashed border-slate-700 bg-slate-900/40 px-2 py-1.5">
      <summary className="cursor-pointer text-xs text-blue-300">Reasoning</summary>
      <pre className="mt-1 whitespace-pre-wrap text-xs text-slate-300">{content}</pre>
    </details>
  );
}
