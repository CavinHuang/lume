/**
 * LLM 上下文注入的结构逃逸防护原语（#795，自 #669 拆分承接）。
 *
 * 外部内容（用户输入/磁盘文件/宿主快照/IM 消息）进入 prompt 时，载荷中的
 * `</tag>` 形态可提前闭合围栏并把后续载荷伪造成围栏外内容。此前的转义/
 * 围栏/政策行实现六处并存且互不一致（desktop_context 与 todo_state 漏转义、
 * trust 词汇九种拼写），收敛为本模块的单一原语。
 *
 * 逃逸防护机制：JSON.stringify 后把 `<` 转义为 `<`——结构标签在词法上
 * 不可能出现在载荷中，任何闭合串都退化为普通字符；JSON 序列化同时钳制
 * 换行/引号等边界字符。
 */

/** prompt 围栏的信任词汇表（#795 收敛：此前九种拼写并存）。 */
export type PromptTrustLevel = "untrusted" | "trusted" | "user" | "policy" | "mixed";

/**
 * 结构逃逸转义：JSON.stringify + `<` → `<`。
 * 载荷以 JSON 字符串字面量形态嵌入围栏，结构标签词法不可达。
 */
export function escapePromptStructure(content: unknown): string {
  return JSON.stringify(content).replaceAll("<", "\\u003c");
}

export interface PromptBlockOptions {
  /** 围栏标签名（无尖括号），如 planning_todo_context */
  tag: string;
  /** 信任词汇；缺省 "untrusted"（fail-closed：不声明即按不可信处理） */
  trust?: PromptTrustLevel;
  /** 附加属性串（原样拼入开标签），如 `source="lume_runtime"`；填充方须保证值不含 `>` */
  attributes?: string;
  /** 头部政策行（围栏外，声明载荷不可作指令） */
  notice?: string;
  /** 尾部封口行（围栏外，重申围栏已闭合、后续系统规则继续生效） */
  closing?: string;
}

/**
 * 不可信内容 → 围栏块的一体化序列化：转义 + trust 属性 + 政策行（#795）。
 * 六处既有注入点（planning/todo_state/desktop_context/browser 系/
 * project-instructions/background-task）统一迁移至此。
 */
export function serializePromptBlock(content: unknown, options: PromptBlockOptions): string {
  const trust = options.trust ?? "untrusted";
  const attrs = options.attributes ? ` ${options.attributes}` : "";
  const lines: string[] = [];
  if (options.notice) lines.push(options.notice);
  lines.push(`<${options.tag} trust="${trust}"${attrs}>\n${escapePromptStructure(content)}\n</${options.tag}>`);
  if (options.closing) lines.push(options.closing);
  return lines.join("\n");
}

/**
 * 结构标签中和（#795 自 im-message-router 收编）：把已知围栏标签的 `<`
 * 替换为 `[`，破坏其词法形态但保留正文可读性——用于需以原文形态展示的
 * 不可信文本（IM 引用/正文），与 escapePromptStructure 的全量 JSON 化互补。
 */
export function neutralizeStructureTags(text: string, tags: readonly string[]): string {
  if (tags.length === 0) return text;
  const pattern = new RegExp(`<\\s*(/?\\s*(?:${tags.join("|")}))`, "gi");
  return text.replace(pattern, "[$1");
}
