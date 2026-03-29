# Lume Engineering Rules (`agents.md`)

## 1. Purpose
This file defines mandatory engineering rules for all follow-up implementation work in this repository.

## 2. Priority
1. Direct user instruction.
2. This `agents.md`.
3. Existing project docs and plans.
4. Personal preference.

If rules conflict, follow the higher-priority item.

## 3. Product and Architecture Boundaries
1. Keep target architecture: `Tauri desktop + Next.js web + Bun sidecar + shared packages`.
2. Keep module boundaries clear:
   - `apps/desktop`: shell, bridge, native lifecycle.
   - `apps/web`: UI only, no direct filesystem/system access.
   - `apps/sidecar`: agent orchestration, storage, provider/runtime logic.
   - `packages/shared`: shared contracts, schemas, constants, pure helpers.
3. No business logic duplication across apps.
4. Cross-layer communication must go through explicit contracts.

## 4. Migration Policy (Proma -> Lume)
1. Prefer direct migration of proven modules before rewriting.
2. Preserve behavior first, refactor second.
3. For migrated files, keep a short header comment: source path + adaptation notes.
4. Replace Electron-only APIs with Tauri/sidecar-compatible abstractions; do not leak Electron assumptions.
5. Do not silently change user-visible behavior during migration.

## 5. Code Organization
1. One domain, one module group; avoid god files.
2. Separate pure logic from IO side effects.
3. Keep state transition logic pure and testable.
4. Use explicit filenames:
   - `*-service.ts` for orchestration with side effects.
   - `*-manager.ts` for persistence/index management.
   - `types.ts` for domain types.
   - `constants.ts` for stable constants.
5. Shared contracts live in `packages/shared` only.

## 6. TypeScript Standards
1. Strict TypeScript only.
2. No `any` unless explicitly justified with TODO and owner.
3. Prefer `interface` for object contracts.
4. Use `import type` for type-only imports.
5. Model nullability explicitly; avoid implicit `undefined` flows.
6. Prefer exhaustive `switch` on tagged unions.

## 7. Style and Readability
1. Keep code simple and direct; avoid overengineering.
2. Names must reflect intent and domain meaning.
3. Functions should do one thing; split when branching complexity grows.
4. Comments explain why, not obvious what.
5. Logs and user-facing copy use Chinese first, with required technical terms kept in English.

## 8. Error Handling and Observability
1. Never swallow errors silently.
2. Return structured errors (`code`, `message`, optional `details`) at boundaries.
3. Log critical path failures with enough context for debugging.
4. Keep local-first logging; no implicit remote telemetry.

## 9. Security and Data Rules
1. Default-deny for risky operations.
2. All path-based operations must normalize and validate against allowed roots.
3. Secrets must never be stored or logged in plaintext.
4. Mask sensitive values in logs and UI.
5. Any permission bypass must be explicit and documented.

## 10. Storage Rules (Fast MVP Stage)
1. File-based storage is allowed for MVP speed.
2. JSON/JSONL writes must be atomic or recoverable.
3. Add version fields to persisted structures from day one.
4. Keep forward migration notes for future SQLite transition.

## 11. Frontend Rules
1. Reuse component primitives; avoid duplicated UI logic.
2. Keep state in atoms/store, not scattered local state for shared flows.
3. Streaming UI must not block input or navigation.
4. Renderer cannot call native APIs directly; use desktop bridge wrapper.
5. Agent 消息列表在 streaming -> final 提交时必须保持布局稳定：
   - 不允许因为流结束默认整表 reload 导致消息列表抖动
   - 不允许因为 temp message / version 切换 / actions 显隐造成整段跳变
   - 优先局部提交最终消息，只有校验失败时才允许 fallback reload

## 12. Testing and Quality Gates
1. New core logic must include at least one automated test or a documented reason.
2. Add smoke coverage for critical user paths:
   - create workspace
   - chat send/stream
   - agent send/stream
   - restart restore
3. Fix regressions before adding new features in the same area.

## 13. Change Management
1. Keep PRs/task changes scoped and reviewable.
2. Update relevant docs when behavior/contract changes.
3. Do not introduce breaking contract changes without migration notes.
4. Keep deferred items explicitly tracked; never drop silently.

## 14. Definition of Good Done
1. Feature works end-to-end in target architecture.
2. Contracts are explicit and typed.
3. Errors are diagnosable.
4. No obvious security regression.
5. Docs and code remain aligned.

## 15. git commit message
1. 必须使用中文
2. 必须符合conventional commit message规范
3. 必须使用emoji
4. commit message必须清晰明了，不要使用模糊的描述
5. commit message必须包含具体的修改内容，不要使用“更新”、“修改”等模糊的描述
