"use client";

import { Switch } from "@/components/ui/switch";
import { DESCRIPTION_CLASS, LABEL_CLASS, ROW_CLASS } from "./SettingsUIConstants";

type SettingsToggleProps = {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
};

export function SettingsToggle({
  label,
  description,
  checked,
  onCheckedChange,
  disabled
}: SettingsToggleProps): React.ReactElement {
  return (
    <div className={ROW_CLASS}>
      <div className="mr-2 min-w-0 flex-1">
        <div className={LABEL_CLASS}>{label}</div>
        {description ? <div className={DESCRIPTION_CLASS}>{description}</div> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}
