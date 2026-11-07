/**
 * 工具参数摘要文本（process-aggregate 三行组件共用：SegmentToolRow / AggregateHoverCard /
 * AggregateToolDetailDrawer 的 paramText 单源）。
 *
 * 字段序 command/path/pattern/query/code 是展示级提取（覆盖高频工具：bash→command、
 * read/write/edit→path、grep→pattern、tool_search→query、codemode→code），非成员资格
 * 判定。两个变体对应两档回退义务：
 * - 行内窄行（SegmentToolRow）：未覆盖形态回退空串（超宽省略是模板层约束，长 JSON 不进窄行）；
 * - 完整参数通道（HoverCard / Drawer）：未覆盖形态回退单行 JSON（「完整参数」义务，不可空手而归）。
 * 归并边界：ToolRow.vue argPath 是近似但不同形的既有实现（无 v.length>0 命中检查、不接
 * string input 原样透传、无 JSON 回退），行为细节属真差异，不并入本单源。
 */
/** 参数摘要字段序（命中优先级从高到低）。 */
const TOOL_ARG_SUMMARY_KEYS = ['command', 'path', 'pattern', 'query', 'code'] as const

/**
 * 字段序命中文本；undefined = 未覆盖形态（string input 原样返回，object 按字段序取第一个
 * 非空 string 值）。回退策略由调用方决定（见本文件头注释的两档义务）。
 */
export function toolArgFieldText(input: unknown): string | undefined {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    for (const key of TOOL_ARG_SUMMARY_KEYS) {
      const v = obj[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
  }
  return undefined
}

/** 字段序命中 + 单行 JSON 回退（完整参数通道变体；JSON 序列化抛错按空串）。 */
export function toolArgSummaryText(input: unknown): string {
  const field = toolArgFieldText(input)
  if (field !== undefined) return field
  if (input && typeof input === 'object') {
    try {
      return JSON.stringify(input)
    } catch {
      return ''
    }
  }
  return ''
}
