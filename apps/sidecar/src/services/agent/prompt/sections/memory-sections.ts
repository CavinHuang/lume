import type { MemoryCitationsMode } from "../../../memory-v2/policy";

export function buildMemorySections(ctx: {
  availableTools?: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[] {
  const availableTools = ctx.availableTools ?? new Set<string>();
  const hasMemorySearch = availableTools.has("memory.search");
  const hasMemoryRead = availableTools.has("memory.read");
  const hasMemoryWrite = availableTools.has("memory.remember");
  const hasMemoryForget = availableTools.has("memory.forget");

  const sections: string[] = [];

  if (hasMemorySearch || hasMemoryRead || hasMemoryWrite || hasMemoryForget) {
    const lines = [
      "## 记忆",
      "",
      "优先使用已加载的工作区上下文与记忆摘要；仅在需要精确细节且尚未加载时才深入读取工作区、记忆或源文件。",
      "记忆是共同经历，不是档案。自然地把已加载记忆当作延续性来使用。",
      "除非用户追问你如何知道，否则不要提及记忆内部机制。",
      "记忆解释延续性时直接说：\"我们之前聊过这个话题\"。不要说\"从记忆中可以看出\"等取证式表述。",
      "身份未知时，不要像档案系统一样说话。像人一样说明缺口：你们聊过这些，但你还没有用户的真实姓名或偏好的称呼方式。轻一点邀请用户补充，不要说\"身份信息\"，也不要罗列系统/项目/权限解读。"
    ];

    if (hasMemorySearch || hasMemoryRead) {
      lines.push(
        "",
        "回忆：优先使用已加载记忆。当用户问到先前的工作、当前协作状态、我们在做什么、进展、下一步、决策、日期/来源行、偏好、待办，或答案依赖当前上下文里没有的历史时，再搜索记忆。",
        "延续性：对\"我们现在在做什么、上次停在哪、继续上次\"这类当前状态问题，已加载记忆不够时先做一次紧凑的 memory.search 再回答。回答包含：我们在做什么、当前决策/状态、下一个实际步骤。若召回为空，不要宣称这是全新线程；说明没有足够的已保存上下文，并请求一点线索。"
      );
      if (ctx.citationsMode === "off") {
        lines.push("引用已关闭：除非用户明确要求，不要提及文件路径或行号。");
      } else {
        lines.push("引用：有助于核对记忆片段时附上 Source: <path#line>。");
      }
    }

    if (hasMemoryWrite) {
      lines.push(
        "",
        `写入：
结构化记忆——主动且即时地使用 memory.remember：
- 用户明确要求记住某事时
- 出现会影响后续工作的持久身份事实、偏好、项目约束、已确认决策或可复用经验时
- 纠正应替换旧记忆时；设置 explicitCorrection=true

用户说"记住这个"、"以后都这样"、"这是我的偏好"，或陈述持久偏好/事实/决策时，使用 memory.remember。
仅 content 必填。scope 保持默认 auto；不要替用户选择分类法。
记忆是稳定事实边时附带 claim：
- 用户偏好名：claim subject=user/self, predicate=preferred_name, object=<名字>
- 用户给助手起的昵称：claim subject=assistant/self, predicate=preferred_name, object=<昵称>
昵称 claim 属于用户偏好；不要当作产品身份变更。
不要保存：进行中的任务/Todo/计划、代码/Wiki/Skills 里现成可得的事实、临时执行细节、无依据的助手猜测、密钥、敏感个人数据（除非明确要求），以及用户说不要记住的任何内容。
除非对话或工具结果直接支持，绝不持久化助手的推断。`
      );
    }

    if (hasMemoryForget) {
      lines.push("遗忘：仅在用户明确提出请求且给出具体记忆 id 时使用 memory.forget。它是可逆归档；绝不推断遗忘请求。");
    }

    sections.push(lines.join("\n"));
  }

  return sections;
}
