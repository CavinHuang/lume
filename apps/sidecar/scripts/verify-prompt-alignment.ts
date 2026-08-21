/**
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
  workspaceSlug: "test-ws",
  sessionId: "test-session-001",
  availableTools: ["read", "write", "edit", "bash", "memory.search", "memory.read", "memory.remember", "browser", "web_search"],
  permissionMode: "default",
});

check("标准模式 — Execution Modes", standardPrompt, "## Execution Modes");
check("标准模式 — 合并后的能力路由阶梯", standardPrompt, "use a loaded Skill when it clearly matches the request");
check("标准模式 — AskUserQuestion 澄清边界", standardPrompt, "AskUserQuestion 用于需求澄清或关键取舍");
check("标准模式 — brainstorming 引导", standardPrompt, "Use brainstorming only for ambiguous product/design exploration");
check("标准模式 — 反偏见指引", standardPrompt, "不要盲目附和");
// 标准模式不应包含"严禁调用 AskUserQuestion"
const standardHasBan = standardPrompt.includes("严禁调用 AskUserQuestion");
if (!standardHasBan) {
  console.log(`  ${GREEN}✓${RESET} 标准模式 — 无禁止 AskUserQuestion（正确）`);
  passed++;
} else {
  console.log(`  ${RED}✗${RESET} 标准模式 — 不应包含禁止 AskUserQuestion`);
  failed++;
}

check("标准模式 — explorer 角色", standardPrompt, "explorer");
check("标准模式 — planner 角色", standardPrompt, "planner");
check("标准模式 — researcher 角色", standardPrompt, "researcher");
check("标准模式 — code-reviewer 角色", standardPrompt, "code-reviewer");

// === 场景 2: bypassPermissions 模式 ===
section("场景 2: bypassPermissions 模式 System Prompt");
const autoPrompt = buildSystemPromptAppend({
  workspaceSlug: "test-ws",
  sessionId: "test-session-002",
  availableTools: ["read", "write", "edit", "bash"],
  permissionMode: "bypassPermissions",
});

check("P0-3: 自动模式 — 禁止 AskUserQuestion", autoPrompt, "严禁调用 AskUserQuestion");
check("P0-3: 自动模式 — 完全自动模式说明", autoPrompt, "完全自动模式");
check("P0-3: 自动模式 — 文本提问引导", autoPrompt, "直接在回复文本中向用户提问");
check("P0-3: 自动模式 — 保留反偏见指引", autoPrompt, "不要盲目附和");

// === 场景 3: plan 模式 ===
section("场景 3: plan 模式 System Prompt");
const planPrompt = buildSystemPromptAppend({
  workspaceSlug: "test-ws",
  sessionId: "test-session-003",
  availableTools: ["read", "write", "edit", "bash"],
  permissionMode: "plan",
});

check("P0-3: 计划模式 — AskUserQuestion 澄清", planPrompt, "AskUserQuestion 澄清需求");
check("P0-3: 计划模式 — AskUserQuestion 不做审批", planPrompt, "不要用 AskUserQuestion 请求计划审批");
check("P0-3: 计划模式 — planner 辅助设计", planPrompt, "先探索，再调用 planner");
check("P0-3: 计划模式 — planner 不做审批", planPrompt, "planner 只提供设计草案");
check("P0-3: 计划模式 — Task 不需要单独审批", planPrompt, "Task 不需要单独审批");
check("P0-3: 计划模式 — TodoWrite 仅用于执行阶段", planPrompt, "TodoWrite 只记录执行阶段");
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
  workspaceSlug: "test-ws",
  sessionId: "base-session",
  availableTools: ["read", "write", "edit", "bash", "memory.search", "memory.read", "memory.remember"],
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
