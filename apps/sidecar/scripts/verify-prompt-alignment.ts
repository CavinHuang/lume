/**
 * 验证 Proma → Lume P0/P1 功能对齐的 System Prompt 和 Dynamic Context 输出。
 * 运行: cd apps/sidecar && bun run scripts/verify-prompt-alignment.ts
 */
import { buildSystemPromptAppend, buildDynamicContext } from "../src/services/agent/agent-prompt-builder";
import type { PermissionMode } from "../src/services/agent/agent-prompt-builder";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;

function check(label: string, text: string, pattern: string | RegExp) {
  const found = typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
  if (found) {
    console.log(`  ${GREEN}✓${RESET} ${label}`);
    passed++;
  } else {
    console.log(`  ${RED}✗${RESET} ${label}  (未找到: ${pattern})`);
    failed++;
  }
}

function section(title: string) {
  console.log(`\n${BOLD}${CYAN}▸ ${title}${RESET}`);
}

// === 场景 1: 标准模式（default permissionMode） ===
section("场景 1: 标准模式 System Prompt");
const standardPrompt = buildSystemPromptAppend({
  workspaceName: "测试工作区",
  workspaceSlug: "test-ws",
  sessionId: "test-session-001",
  availableTools: ["read", "write", "edit", "bash", "memory_search", "memory_get", "memory_save", "browser", "web_search"],
  permissionMode: "default",
});

// P0-2: 知识管理
check("P0-2: 知识管理章节存在", standardPrompt, "文档输出与知识管理");
check("P0-2: AGENTS.md 维护指引", standardPrompt, "AGENTS.md — 项目知识库");
check("P0-2: .context 目录说明", standardPrompt, ".context/ 目录 — 结构化工作文档");
check("P0-2: note.md 说明", standardPrompt, "note.md — 研究与分析输出");
check("P0-2: todo.md 说明", standardPrompt, "todo.md — 任务进度追踪");
check("P0-2: 决策表", standardPrompt, "何时输出到文件 vs 只在聊天中回复");
check("P0-2: .context 目录层级", standardPrompt, ".context 目录层级");
check("P0-2: 会话级 .context", standardPrompt, "会话级");
check("P0-2: 工作区级 .context", standardPrompt, "workspace-files/.context/");
check("P0-2: Session Bootstrap 包含 .context", standardPrompt, "会话级和工作区级 .context/ 目录");
check("P0-2: Session Bootstrap 包含 AGENTS.md", standardPrompt, "工作区的 AGENTS.md");

// P0-3: 标准模式不确定性处理
check("P0-3: 标准模式 — AskUserQuestion 引导", standardPrompt, "尽可能多地使用 AskUserQuestion");
check("P0-3: 标准模式 — brainstorming 引导", standardPrompt, "brainstorming");
check("P0-3: 标准模式 — 反偏见指引", standardPrompt, "不要盲目附和");
// 标准模式不应包含"严禁调用 AskUserQuestion"
const standardHasBan = standardPrompt.includes("严禁调用 AskUserQuestion");
if (!standardHasBan) {
  console.log(`  ${GREEN}✓${RESET} P0-3: 标准模式 — 无禁止 AskUserQuestion（正确）`);
  passed++;
} else {
  console.log(`  ${RED}✗${RESET} P0-3: 标准模式 — 不应包含禁止 AskUserQuestion`);
  failed++;
}

// P0-1: SubAgent 委派策略
check("P0-1: SubAgent 委派策略章节", standardPrompt, "SubAgent 委派策略");
check("P0-1: explorer 角色", standardPrompt, "explorer");
check("P0-1: researcher 角色", standardPrompt, "researcher");
check("P0-1: code-reviewer 角色", standardPrompt, "code-reviewer");
check("P0-1: haiku 模型建议", standardPrompt, "haiku");
check("P0-1: 不需要委派场景", standardPrompt, "不需要委派的场景");

// P1-2: 记忆哲学
check("P1-2: 记忆系统哲学章节", standardPrompt, "记忆系统");
check("P1-2: 共同经历", standardPrompt, "共同的经历");
check("P1-2: 自然带入", standardPrompt, "像老搭档一样自然地带入");
check("P1-2: 反机械引用", standardPrompt, "根据记忆记录");
check("P1-2: 存储要点", standardPrompt, "记的是经历和结论，不是对话流水账");

// === 场景 2: bypassPermissions 模式 ===
section("场景 2: bypassPermissions 模式 System Prompt");
const autoPrompt = buildSystemPromptAppend({
  workspaceName: "测试工作区",
  workspaceSlug: "test-ws",
  sessionId: "test-session-002",
  availableTools: ["read", "write", "edit", "bash"],
  permissionMode: "bypassPermissions",
});

check("P0-3: 自动模式 — 禁止 AskUserQuestion", autoPrompt, "严禁调用 AskUserQuestion");
check("P0-3: 自动模式 — 完全自动模式说明", autoPrompt, "完全自动模式");
check("P0-3: 自动模式 — 文本提问引导", autoPrompt, "直接在回复文本中向用户提问");
check("P0-3: 自动模式 — 使用 Planning Protocol", autoPrompt, "Planning Protocol");

// === 场景 3: plan 模式 ===
section("场景 3: plan 模式 System Prompt");
const planPrompt = buildSystemPromptAppend({
  workspaceName: "测试工作区",
  workspaceSlug: "test-ws",
  sessionId: "test-session-003",
  availableTools: ["read", "write", "edit", "bash"],
  permissionMode: "plan",
});

check("P0-3: 计划模式 — 禁止 AskUserQuestion", planPrompt, "严禁调用 AskUserQuestion");
check("P0-3: 计划模式 — 增强计划章节", planPrompt, ".context/plan/");
check("P0-3: 计划模式 — 展示摘要后等确认", planPrompt, "等待用户确认");
// 计划模式不应包含原始 Planning Protocol，而是使用增强版计划章节
const planHasPlanningProtocol = planPrompt.includes("Planning Protocol");
if (!planHasPlanningProtocol) {
  console.log(`  ${GREEN}✓${RESET} P0-3: 计划模式 — 已替换为增强计划章节（正确）`);
  passed++;
} else {
  console.log(`  ${RED}✗${RESET} P0-3: 计划模式 — 仍包含原始 Planning Protocol`);
  failed++;
}

// === 场景 4: Dynamic Context with skill-creator ===
section("场景 4: Dynamic Context — skill_improvement_hint 注入");

// 注意: buildDynamicContext 会调用 getWorkspaceSkills，在无实际工作区环境时可能返回空
// 这里我们只验证函数不抛错，实际的 skill_improvement_hint 需要真实工作区
try {
  const dynCtx = buildDynamicContext({
    sessionId: "test-session-004",
    workspaceName: "测试工作区",
    workspaceSlug: "test-ws",
    agentCwd: "/tmp/test",
    availableTools: ["read", "write"],
  });
  check("P1-3: buildDynamicContext 不抛错", "ok", "ok");
  check("P1-3: 输出包含时间", dynCtx, "当前时间");
  // skill_improvement_hint 检查（依赖真实 skills 目录，这里只验证代码路径不崩）
  console.log(`  ${YELLOW}⚠${RESET} P1-3: skill_improvement_hint 需要真实工作区环境验证（skill-creator 需存在于 skills/）`);
} catch (err) {
  console.log(`  ${RED}✗${RESET} P1-3: buildDynamicContext 抛错: ${err}`);
  failed++;
}

// === 场景 5: 无记忆工具时不注入记忆章节 ===
section("场景 5: 无记忆工具时的 Prompt");
const noMemPrompt = buildSystemPromptAppend({
  workspaceName: "测试工作区",
  workspaceSlug: "test-ws",
  sessionId: "test-session-005",
  availableTools: ["read", "write", "edit"],
});

// 无记忆工具时不应注入记忆相关章节
const noMemHasPhilosophy = noMemPrompt.includes("共同的经历");
if (!noMemHasPhilosophy) {
  console.log(`  ${GREEN}✓${RESET} 无记忆工具时不含记忆哲学（正确）`);
  passed++;
} else {
  console.log(`  ${RED}✗${RESET} 无记忆工具时不应包含记忆哲学`);
  failed++;
}
const noMemHasRecall = noMemPrompt.includes("Memory Recall");
if (!noMemHasRecall) {
  console.log(`  ${GREEN}✓${RESET} 无记忆工具时不含 Memory Recall（正确）`);
  passed++;
} else {
  console.log(`  ${RED}✗${RESET} 无记忆工具时不应包含 Memory Recall`);
  failed++;
}

// === Token 估算 ===
section("Token 开销估算");

const basePrompt = buildSystemPromptAppend({
  workspaceName: "测试工作区",
  workspaceSlug: "test-ws",
  sessionId: "base-session",
  availableTools: ["read", "write", "edit", "bash", "memory_search", "memory_get", "memory_save"],
});

// 粗略估算: 1 token ≈ 4 字符（中文约 1.5 字符/token）
const charCount = basePrompt.length;
const approxTokens = Math.round(charCount / 2.5); // 中英混合取 2.5
console.log(`  完整 Prompt 字符数: ${charCount}`);
console.log(`  估算 token 数: ~${approxTokens}`);

// === 总结 ===
console.log(`\n${BOLD}══════════════════════════════════${RESET}`);
console.log(`${BOLD}验证结果: ${GREEN}${passed} 通过${RESET}  ${failed > 0 ? RED : ""}${failed} 失败${RESET}`);
console.log(`${BOLD}══════════════════════════════════${RESET}`);

if (failed > 0) {
  process.exit(1);
}
