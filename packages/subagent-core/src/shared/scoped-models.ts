// src/shared/scoped-models.ts
//
// taiji scoped-models 白名单：归一化 + 断言（纯函数，无 IO）。
//
// 白名单语义：空数组 = 未启用 = 全量放行；非空 = 显式指定的派发模型（工具参数 /
// agent frontmatter / 用户热切覆盖）必须在白名单内，ctxModel 继承层不拦
//（2026-11-01 裁决）。权威文件与读取（IO）单源 = execution/assembly/scoped-models.ts
//（`<agentDir>/config/providers.json`，runtime 写 / 扩展进程读的跨进程契约文件）。
//
// 归一化口径：写入侧 isModelRef 放行带 `:thinkingLevel` 后缀的条目落盘，而所有
// 比对必须用无后缀口径——一律经 scopedModelKey 剥后缀后比较（单点，两侧共用；
// runtime 侧 aggregateModelsWithScoped 的 Map key 同样经此归一）。

import { parseModelSelector } from "./model-ref.ts";

/** 归一化比对键：剥 `:thinkingLevel` 后缀的 `provider/id`（单点，见文件头）。 */
export function scopedModelKey(ref: string): string {
  return parseModelSelector(ref).ref;
}

const SCOPED_LIST_LIMIT = 20;

/**
 * 白名单断言（显式指定路径的派发校验）。白名单为空直接放行；命中（剥后缀口径）
 * 放行；否则抛错——文案对齐既有拒单范式：点破校验源独立 + 列可用清单（上限 20）
 * + 恢复指引，不代改输入。
 */
export function assertModelWithinScoped(
  modelStr: string,
  scopedModels: readonly string[],
  source: string,
): void {
  if (scopedModels.length === 0) return;
  const key = scopedModelKey(modelStr);
  if (scopedModels.some((scoped) => scopedModelKey(scoped) === key)) return;
  const allowed = scopedModels.slice(0, SCOPED_LIST_LIMIT).map((s) => `  ${scopedModelKey(s)}`);
  throw new Error(
    `Model "${modelStr}" (${source}) is available but outside the scoped-models allowlist. ` +
      `Dispatch model selection is limited to the scoped models configured in taiji settings ` +
      `(providers.json "scopedModels").\nAllowed models:\n${allowed.join("\n")}` +
      (scopedModels.length > SCOPED_LIST_LIMIT
        ? `\n  ...and ${scopedModels.length - SCOPED_LIST_LIMIT} more`
        : "") +
      `\nPick a model from the list above, or ask the user to extend the allowlist in settings.`,
  );
}
