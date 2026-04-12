import * as React from "react";
import { FileIcon, FolderIcon } from "@react-symbols/icons/utils";

interface FileTypeIconProps {
  name: string;
  isDirectory: boolean;
  isOpen?: boolean;
  size?: number;
  className?: string;
}

export const FileTypeIcon = React.memo(function FileTypeIcon({
  name,
  isDirectory,
  size = 16,
  className,
}: FileTypeIconProps): React.ReactElement {
  if (isDirectory) {
    return (
      <span
        className={className}
        style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
      >
        <FolderIcon folderName={name} width={size} height={size} />
      </span>
    );
  }

  return (
    <span
      className={className}
      style={{ width: size, height: size, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
    >
      <FileIcon fileName={name} autoAssign width={size} height={size} />
    </span>
  );
});
