"use client";

import type { AgentWorkspace } from "@lume/shared";

type WorkspaceSelectorProps = {
  workspaces: AgentWorkspace[];
  value: string | null;
  onChange: (workspaceId: string | null) => void;
};

export function WorkspaceSelector({
  workspaces,
  value,
  onChange
}: WorkspaceSelectorProps): React.ReactElement {
  return (
    <select
      className="h-9 rounded-md border border-slate-700 bg-slate-950 px-2.5 text-sm text-slate-200 outline-none focus:border-cyan-400"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">选择工作区</option>
      {workspaces.map((workspace) => (
        <option key={workspace.id} value={workspace.id}>
          {workspace.name}
        </option>
      ))}
    </select>
  );
}
