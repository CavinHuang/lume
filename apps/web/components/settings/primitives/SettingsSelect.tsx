"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { DESCRIPTION_CLASS, LABEL_CLASS } from "./SettingsUIConstants";

type SelectOption = {
  value: string;
  label: string;
};

type SettingsSelectProps = {
  label: string;
  description?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
};

export function SettingsSelect({
  label,
  description,
  value,
  onValueChange,
  options,
  placeholder,
  disabled
}: SettingsSelectProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5 px-1 py-1">
      <div className={LABEL_CLASS}>{label}</div>
      {description ? <div className={DESCRIPTION_CLASS}>{description}</div> : null}
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger className="border-slate-700 bg-slate-950">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
