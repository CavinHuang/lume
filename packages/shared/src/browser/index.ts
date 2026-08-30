/**
 * 内嵌浏览器(IAB)协议包出口。
 *
 * 布局(design doc §2.1):
 *   - constants.ts:协议版本/分区/恢复协议/视口边界/事件频道名表
 *   - errors.ts:稳定错误码 + sideEffect 语义
 *   - protocol.ts:46 命令 zod 单源(请求上下文/结果 meta/playwright/录制)
 *   - capabilities.ts:capability 描述符 + apiSupport 矩阵
 *   - descriptor.ts:IAB 后端描述符 ZCode 形状单源工厂
 */
export * from "./constants"
export * from "./errors"
export * from "./protocol"
export * from "./capabilities"
export * from "./descriptor"
