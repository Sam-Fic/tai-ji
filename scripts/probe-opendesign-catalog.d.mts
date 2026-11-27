/**
 * scripts/probe-opendesign-catalog.mjs 的类型声明（供 packages/runtime 的单测 import）。
 *
 * 脚本本身是纯 ESM 手动工具、无构建步骤；这里只声明单测实际消费的那几个导出，避免
 * 测试文件里挂 @ts-expect-error（本仓 check_staged_forbidden_lines 禁无说明的豁免行）。
 * 脚本新增导出而单测需要消费时，同步补这里。
 */

export type ProbeLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export declare const PROVIDER_ID: string
export declare const ALL_LEVELS: readonly ProbeLevel[]

export declare const COMPAT: {
  thinkingFormat: 'deepseek'
  supportsDeveloperRole: false
  supportsReasoningEffort: true
  requiresReasoningContentOnAssistantMessages: true
}

export type LevelVerdict = 'accepted' | 'rejected' | 'unstable'

/** 探测结论 → thinkingLevelMap（accepted → identity；其余 → null）。 */
export declare function buildThinkingLevelMap(
  verdicts: ReadonlyMap<string, LevelVerdict>,
): Record<string, string | null>

/** architecture.input_modalities → pi 的 input（只留 text/image）。 */
export declare function toPiInput(architecture: unknown): Array<'text' | 'image'>

/** 差异补丁域形状（与 runtime 的 ProviderModelMetadataConfig 同形，此处独立声明免跨包依赖）。 */
export interface ProbeModelPatch {
  id: string
  [field: string]: unknown
}

/** 探测产出的模型元数据（与 ProbeModelPatch 同为宽松 index 形状）。 */
export type ProbeModelMeta = Record<string, unknown>

export interface ProbeMetadataDraft {
  version: 1
  providers: Array<{
    id: string
    models: ProbeModelMeta[]
    removeModels?: string[]
  }>
}

/** 探测结果 ⊕ 快照 → 差异补丁（只带差异字段；下线模型进 removeModels）。 */
export declare function diffAgainstSnapshot(
  draft: ProbeMetadataDraft,
  snapshot: ReadonlyMap<string, Record<string, unknown>> | undefined,
): ProbeMetadataDraft
