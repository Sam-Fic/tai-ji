// src/execution/assembly/scoped-models.ts
//
// taiji scoped-models 白名单：派发域的文件读取（IO）单源。
//
// 权威文件 = `<agentDir>/config/providers.json` 顶层 `scopedModels` 字段（string[]，
// 条目 "provider/modelId"）。写入方 = runtime 侧 ProviderExtrasStore
//（packages/runtime/src/services/provider-extras-store.ts，设置页 UI 编辑）；读取方 =
// 本模块（ModelConfigService 消费，派发校验链 + 模型清单注入器）。跨进程契约：
// runtime 写、扩展进程读，文件即真相（每派发现读，无快照陈旧问题）。路径公式 SSOT =
// @taiji/shared/provider-store-paths 纯模块（runtime 写侧与 provider-aggregation
// 扩展 config-store 同源消费，公式漂移结构上不可能）；本模块只传本进程 agentDir
//（两侧 agentDir 同源：runtime spawn pi 恒设 PI_CODING_AGENT_DIR env）。
//
// 归一化 + 白名单断言的纯函数单源在 shared/scoped-models.ts（本文件 re-export，
// barrel 单点导出）；空数组 = 白名单未启用 = 全量放行。

import { readFileSync } from "node:fs";

import { getProviderExtrasPath } from "@taiji/shared/provider-store-paths";

export { assertModelWithinScoped, scopedModelKey } from "../../shared/scoped-models.ts";

/** 白名单文件路径（公式本体 = shared provider-store-paths 纯模块；见文件头）。 */
export function getScopedModelsPath(agentDir: string): string {
  return getProviderExtrasPath(agentDir);
}

/**
 * 读 scopedModels 白名单。任何读侧异常静默回空数组（= 全量放行）：
 * 文件不存在（用户从未配置白名单）是常态；坏 JSON / 字段非 string[] 属配置侧
 * 故障，放行优于误杀（白名单是收紧面不是安全边界，宽松失效方向正确）。
 */
export function readScopedModels(agentDir: string): string[] {
  try {
    const raw = readFileSync(getScopedModelsPath(agentDir), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && "scopedModels" in parsed) {
      const scoped: unknown = parsed.scopedModels;
      if (Array.isArray(scoped)) {
        return scoped.filter((entry): entry is string => typeof entry === "string");
      }
    }
    return [];
  } catch {
    return [];
  }
}
