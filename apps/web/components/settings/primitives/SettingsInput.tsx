"use client";

import { Input } from "@/components/ui/input";
import { DESCRIPTION_CLASS, LABEL_CLASS } from "./SettingsUIConstants";

type SettingsInputProps = {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  type?: string;
};

export function SettingsInput({
  label,
  description,
  value,
  onChange,
  placeholder,
  required,
  disabled,
  error,
  type = "text"
}: SettingsInputProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5 px-1 py-1">
      <div className={LABEL_CLASS}>{label}</div>
      {description ? <div className={DESCRIPTION_CLASS}>{description}</div> : null}
      <Input
        className="border-slate-700 bg-slate-950"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
      />
      {error ? <div className="text-xs text-red-300">{error}</div> : null}
    </div>
  );
}
