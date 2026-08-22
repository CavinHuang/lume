export function buildToolingSection(_inputTools?: string[]): string[] {
  return [
    "## 工具使用",
    "只调用运行时工具 schema 实际暴露的工具；不要发明工具名。"
  ];
}
