"use client";

type ContextSettingsPopoverProps = {
  contextLength: number | "infinite";
  onChange: (value: number | "infinite") => void;
};

export function ContextSettingsPopover({
  contextLength,
  onChange
}: ContextSettingsPopoverProps): React.ReactElement {
  return (
    <label className="text-xs text-muted-foreground">
      Context
      <select
        className="ml-2 h-8 min-w-[120px] rounded-md border border-slate-700 bg-slate-950 px-2 text-sm text-slate-200 outline-none focus:border-cyan-400"
        value={String(contextLength)}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "infinite") onChange("infinite");
          else onChange(Number(value));
        }}
      >
        <option value="0">0</option>
        <option value="3">3</option>
        <option value="6">6</option>
        <option value="10">10</option>
        <option value="infinite">infinite</option>
      </select>
    </label>
  );
}
