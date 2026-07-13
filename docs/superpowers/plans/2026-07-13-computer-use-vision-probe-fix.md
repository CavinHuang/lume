# Computer Use Vision Probe Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent reasoning-model output truncation from being cached as lack of vision support.

**Architecture:** Keep the existing probe and router boundaries. Give the fixed-image probe enough output budget, surface `max_tokens` as an incomplete probe, and make the router avoid caching thrown probe failures while preserving deterministic positive and negative caching.

**Tech Stack:** TypeScript, Bun test, existing Lume Agent SDK provider interface.

---

### Task 1: Reproduce incomplete-probe caching

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/computer-use/computer-use-vision-router.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/tools/computer-use/computer-use-vision-router.ts`

- [ ] **Step 1: Write the failing router regression test**

Add a test whose first probe throws `vision_probe_incomplete:max_tokens` and whose second probe succeeds:

```ts
test("does not cache an incomplete probe as unsupported", async () => {
  let probes = 0;
  const router = new ComputerUseVisionRouter({
    attempts: [{
      key: "reasoning-model",
      current: true,
      probe: async () => {
        probes += 1;
        if (probes === 1) throw new Error("vision_probe_incomplete:max_tokens");
        return true;
      },
      analyze: async () => undefined,
    }],
  });

  expect(await router.route("C:/thread/shot-1.png")).toEqual({ status: "vision_unavailable" });
  expect(await router.route("C:/thread/shot-2.png")).toEqual({ status: "image_ready" });
  expect(probes).toBe(2);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
bun test apps/sidecar/src/services/agent-runtime/tools/computer-use/computer-use-vision-router.test.ts
```

Expected: the new test fails because the first thrown probe is cached as `false`, so `probes` remains `1` and the second route is still `vision_unavailable`.

- [ ] **Step 3: Stop caching thrown probe failures**

Change `#supportsVision` so only resolved boolean results enter `probeCache`:

```ts
try {
  const supported = await attempt.probe();
  probeCache.set(attempt.key, { supported, expiresAt: this.#now() + PROBE_TTL_MS });
  log.info("vision probe", { modelKey: attempt.key, supported, ttlMs: PROBE_TTL_MS });
  return supported;
} catch (error) {
  log.info("vision probe incomplete", {
    modelKey: attempt.key,
    reason: error instanceof Error && error.message === "vision_probe_incomplete:max_tokens"
      ? "max_tokens"
      : "probe_error",
  });
  return false;
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run the same Bun test. Expected: all router tests pass.

### Task 2: Detect truncated fixed-image probes

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/computer-use/computer-use-vision-router.test.ts`
- Modify: `apps/sidecar/src/services/agent-runtime/tools/computer-use/computer-use-vision-router.ts`

- [ ] **Step 1: Add a direct probe regression test**

Load the vision module dynamically so the missing export produces an assertion failure rather than a module error. Use a minimal provider double that captures the request and returns `{ stopReason: "max_tokens", content: [] }`. Assert that the probe is exposed, uses `maxTokens: 300`, and rejects with `vision_probe_incomplete:max_tokens`.

```ts
test("treats a max_tokens probe response as incomplete", async () => {
  const visionModule = await import("./computer-use-vision-router");
  const probe = (visionModule as Record<string, unknown>).probeVision;
  expect(probe).toBeFunction();
  const probeFunction = probe as (provider: LLMProvider, model: string) => Promise<boolean>;

  let maxTokens = 0;
  const provider = {
    createMessage: async (request: { maxTokens: number }) => {
      maxTokens = request.maxTokens;
      return { stopReason: "max_tokens", content: [] };
    },
  } as unknown as LLMProvider;

  await expect(probeFunction(provider, "step-3.7-flash")).rejects.toThrow(
    "vision_probe_incomplete:max_tokens",
  );
  expect(maxTokens).toBe(300);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run the targeted test. Expected: it fails at `expect(probe).toBeFunction()` because `probeVision` is not exported.

- [ ] **Step 3: Implement the minimal probe fix**

Export `probeVision`, set `maxTokens: 300`, and reject truncated responses before comparing final text:

```ts
export async function probeVision(provider: LLMProvider, model: string): Promise<boolean> {
  const response = await provider.createMessage({
    model,
    maxTokens: 300,
    // existing system and image message
  });
  if (response.stopReason === "max_tokens") {
    throw new Error("vision_probe_incomplete:max_tokens");
  }
  return responseText(response).trim().toUpperCase() === "RED-BLUE-GREEN-YELLOW";
}
```

- [ ] **Step 4: Run focused and portable verification**

Run:

```powershell
bun test apps/sidecar/src/services/agent-runtime/tools/computer-use/computer-use-vision-router.test.ts
bun run verify:computer-use:portable
```

Expected: both commands exit with code 0.

- [ ] **Step 5: Commit the bug fix**

```powershell
git add apps/sidecar/src/services/agent-runtime/tools/computer-use/computer-use-vision-router.ts apps/sidecar/src/services/agent-runtime/tools/computer-use/computer-use-vision-router.test.ts
git commit -m "🐛 fix(sidecar): 修复视觉探测截断误判"
```
