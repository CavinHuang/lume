"use client";

import { DESCRIPTION_CLASS, LABEL_CLASS } from "./SettingsUIConstants";
import { cn } from "@/lib/utils";

type SegmentOption = {
  value: string;
  label: string;
};

type SettingsSegmentedControlProps = {
  label: string;
  description?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SegmentOption[];
  disabled?: boolean;
};

export function SettingsSegmentedControl({
  label,
  description,
  value,
  onValueChange,
  options,
  disabled
}: SettingsSegmentedControlProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5 px-1 py-1">
      <div className={LABEL_CLASS}>{label}</div>
      {description ? <div className={DESCRIPTION_CLASS}>{description}</div> : null}
      <div className="inline-flex gap-1 rounded-lg border border-slate-700 p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={cn(
              "rounded-md border border-transparent px-3 py-1.5 text-sm transition-colors",
              option.value === value
                ? "border-slate-600 bg-slate-800 text-slate-100"
                : "text-slate-300 hover:bg-slate-800"
            )}
            onClick={() => onValueChange(option.value)}
            disabled={disabled}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
