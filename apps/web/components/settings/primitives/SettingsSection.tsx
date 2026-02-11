"use client";

import type { ReactNode } from "react";
import { SECTION_DESCRIPTION_CLASS, SECTION_TITLE_CLASS } from "./SettingsUIConstants";

type SettingsSectionProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
};

export function SettingsSection({
  title,
  description,
  action,
  children
}: SettingsSectionProps): React.ReactElement {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-2.5">
        <div>
          <h4 className={SECTION_TITLE_CLASS}>{title}</h4>
          {description ? <p className={SECTION_DESCRIPTION_CLASS}>{description}</p> : null}
        </div>
        {action ? <div>{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
