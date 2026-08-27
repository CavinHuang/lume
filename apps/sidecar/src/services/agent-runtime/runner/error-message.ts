/**
 * 运行时错误消息人性化层——实现已下沉 @lume/shared（二轮 review P2:packages/sdk
 * 的 lifecycle-projector 终值出口与 sidecar runner 共用同一份映射）。保留本壳
 * 维持 sidecar 内既有 import 路径稳定。
 */
export { humanizeRuntimeErrorMessage } from "@lume/shared";
