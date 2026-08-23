// 单测 preload:为 bun test 注入 RuntimeHostPorts 真实现(#289)。
// 经 apps/sidecar/scripts/run-unit-tests.mjs 的 --preload 生效;
// 手动直跑单个测试文件时请加:
//   bun test --preload ./apps/sidecar/scripts/host-ports-test-preload.ts <file>
import { installRuntimeHostPorts } from "../src/services/agent/agent-runtime-ports-binding";

installRuntimeHostPorts();
