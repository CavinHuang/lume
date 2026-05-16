# Lume Plan/Task Real Case: Subscription Billing Proration

Status: Ready for manual product testing.

## Goal

Use a realistic but isolated TypeScript billing module to test Lume's complete plan/task loop:

1. Plan mode explores an existing workspace without editing files.
2. Agent writes a verified Markdown plan through `TaskContractWrite`.
3. Web shows the plan preview card and bottom approval overlay.
4. Rejection feedback returns to planning.
5. Approval starts task execution.
6. Task execution edits files, reports progress, runs tests, and summarizes results.

The case intentionally uses a small business rule change with enough detail to force real planning and implementation, while keeping the blast radius outside the Lume repo.

## Setup Workspace

Create a throwaway workspace outside the Lume repo:

```bash
mkdir -p /tmp/lume-plan-task-case/src
cd /tmp/lume-plan-task-case
cat > package.json <<'JSON'
{
  "name": "lume-plan-task-case",
  "type": "module",
  "scripts": {
    "test": "bun test"
  },
  "devDependencies": {}
}
JSON

cat > README.md <<'MD'
# Subscription Billing Case

This tiny module calculates subscription invoices for a SaaS product.

Current behavior:
- Supports monthly billing only.
- Uses integer cents.
- Applies add-ons after base seat pricing.
- Adds 8.25% tax.

Target behavior should preserve existing monthly results while adding annual billing and prorated seat changes.
MD

cat > src/billing.ts <<'TS'
export type BillingPlan = "starter" | "growth" | "enterprise";

export interface MonthlyBillInput {
  plan: BillingPlan;
  seats: number;
  addOns?: Array<{ name: string; cents: number }>;
}

const PLAN_CENTS: Record<BillingPlan, number> = {
  starter: 1200,
  growth: 2400,
  enterprise: 4800,
};

const TAX_RATE = 0.0825;

export function calculateMonthlyBill(input: MonthlyBillInput) {
  if (!Number.isInteger(input.seats) || input.seats <= 0) {
    throw new Error("seats must be a positive integer");
  }

  const baseCents = PLAN_CENTS[input.plan] * input.seats;
  const addOnCents = (input.addOns ?? []).reduce((sum, item) => sum + item.cents, 0);
  const subtotalCents = baseCents + addOnCents;
  const taxCents = Math.round(subtotalCents * TAX_RATE);

  return {
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  };
}
TS

cat > src/billing.test.ts <<'TS'
import { describe, expect, test } from "bun:test";
import { calculateMonthlyBill } from "./billing";

describe("calculateMonthlyBill", () => {
  test("calculates monthly billing with add-ons", () => {
    expect(calculateMonthlyBill({
      plan: "growth",
      seats: 3,
      addOns: [{ name: "support", cents: 1500 }],
    })).toEqual({
      subtotalCents: 8700,
      taxCents: 718,
      totalCents: 9418,
    });
  });

  test("rejects invalid seats", () => {
    expect(() => calculateMonthlyBill({ plan: "starter", seats: 0 })).toThrow(
      "seats must be a positive integer",
    );
  });
});
TS

bun test
```

Open `/tmp/lume-plan-task-case` as the target workspace in Lume.

## Test Prompt

Paste this into a new Lume thread in plan mode:

```text
请先只读分析这个 workspace，不要修改文件。

我们要把当前 SaaS 订阅计费模块升级为支持年度计费和席位变更按天折算。请先给我一个可审批计划；等我批准后再实施。

业务需求：
1. 保留现有 calculateMonthlyBill 的行为和测试结果。
2. 新增 calculateSubscriptionInvoice(input)，支持 billingPeriod: "monthly" | "annual"。
3. 月付保持当前价格逻辑；年付按 12 个月计算后打 85 折。
4. 新增 proratedSeatChanges：
   - 每项包含 seatsAdded 和 remainingDaysInCycle。
   - 每个周期按 30 天计算。
   - 月付按单月 seat price 折算。
   - 年付按年付折后单月等效价格折算。
5. 所有金额都必须使用 integer cents，不能出现浮点金额输出。
6. 返回值需要包含 lineItems、subtotalCents、taxCents、totalCents。
7. 补充 bun test 覆盖：
   - 现有月付结果不变。
   - 年付 2 个 growth 席位的折扣结果。
   - 月付中途加 2 个 starter 席位、剩余 15 天的折算。
   - seatsAdded 或 remainingDaysInCycle 非法时抛错。
8. 更新 README，记录新的公开 API 和一个示例。

请在计划里明确你会读哪些文件、改哪些文件、补哪些测试、如何验证。
```

## Approval Flow Checks

Before approval:

- Agent should inspect `README.md`, `src/billing.ts`, and `src/billing.test.ts`.
- No source file should be modified before approval.
- A Markdown plan should appear in the assistant message as a large gray preview card.
- The preview card should offer copy, open file, and expand/collapse controls.
- The bottom composer area should be covered by the approval card.
- The default selected action should be `是，实施此计划`.

Reject path:

1. Choose `否，请告知 Lume 如何调整`.
2. Enter: `请把 README 更新放到最后一步，并强调不要改 calculateMonthlyBill 的签名。`
3. Submit.
4. Expected: Lume returns to planning and produces an updated plan preview.

Approve path:

1. Approve the updated plan.
2. Expected: task execution starts.
3. Expected: progress updates appear while files are edited and tests run.
4. Expected: final summary states what changed and whether `bun test` passed.

## Expected Implementation Shape

The approved task should produce a result close to this:

- `src/billing.ts`
  - Keeps `calculateMonthlyBill(input)` unchanged as a public function.
  - Adds new input/output types for subscription invoices.
  - Adds `calculateSubscriptionInvoice(input)`.
  - Validates positive integer seats and valid proration ranges.
  - Uses `Math.round` only at clear cents boundaries.
- `src/billing.test.ts`
  - Keeps existing tests.
  - Adds annual billing and proration tests.
- `README.md`
  - Documents `calculateSubscriptionInvoice`.
  - Shows one monthly or annual example.

## Acceptance Criteria

- Plan mode creates `plans/{contractId}.md` and `plan.preview`.
- Refreshing the thread still shows the same plan preview from run history.
- Reject feedback generates a revised plan instead of starting execution.
- Approval calls the task execution path, not a normal chat continuation.
- The task modifies only `README.md`, `src/billing.ts`, and `src/billing.test.ts`.
- `bun test` passes in `/tmp/lume-plan-task-case`.
- Final task report clearly lists changed files and test result.

## Why This Case Works

This is realistic enough to require real code reading, API design, validation, tests, and docs. It is also small enough that a correct agent should finish in one task run. Because it runs in `/tmp/lume-plan-task-case`, failures are easy to inspect and cleanup without touching the Lume monorepo.
