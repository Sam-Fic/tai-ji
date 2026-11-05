// src/execution/engine/common/kill-chain.ts
//
// 杀链与 abort 兜底的 re-export shim：实现体单源
// @zhushanwen/subagent-engine-sdk（自本文件逐字等价移入 SDK，s4-reuse 簇 1；
// core → SDK 边界正向合法，设计权威源 D1/§3.3.3 注释随实现留在 SDK 侧）。
// core 内消费方 import 路径保持不变。

export {
  abortWithFallback,
  killChain,
  type KillableChild,
} from "@zhushanwen/subagent-engine-sdk";
