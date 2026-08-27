/**
 * 工作区模板文档的通用处理原语。
 * stripFrontMatter 为 #531 复审收敛后的唯一实现（CRLF-aware，
 * 闭合符 "---" 必须独占一行）；此前 project-instructions / bootstrap 用的
 * 手工 indexOf 版与 workspace-doc-sanitizer 的正则版并存且边界行为有异。
 */
export function stripFrontMatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}
