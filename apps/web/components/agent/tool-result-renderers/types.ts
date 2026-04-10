export interface ToolResultContentProps {
  result: string;
  isError: boolean;
  input: Record<string, unknown>;
}

export interface ToolResultRendererProps extends ToolResultContentProps {
  toolName: string;
}

