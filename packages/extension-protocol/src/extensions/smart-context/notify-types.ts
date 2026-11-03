/**
 * smart-context 扩展通知通道的 custom_message customType 单源（subagent-notify 词表同款跨层契约）。
 *
 * 契约两端（值逐字节依赖，改名 = 跨侧破坏性变更）：
 *   - 写侧：@zhushanwen/pi-smart-context extension（阈值/模型/压缩结果可见通知 +
 *     后台压缩落盘信号，均经 pi.sendMessage 落 custom_message entry 进 session JSONL）；
 *   - 读侧：taiji runtime event-interpreter（落盘信号分诊：customType + details.source
 *     双判据，命中后合成分界行帧）。
 *
 * 历史上 customType 常量只在扩展本地定义（runtime 分诊引入前无跨层消费者），收敛本单源
 * 后两侧 import 同一常量，值漂移结构性不可能（扩展侧 re-export 保持既有 import 路径不变）。
 */

/** smart-context 通知的送达 customType（对话流可见性由 display 字段区分，非 customType）。 */
export const SMART_CONTEXT_NOTICE_CUSTOM_TYPE = 'smart-context' as const

/** 后台压缩落盘信号的 details.source 取值：compaction entry 已 append 进 session 文件。 */
export const COMPACTION_ENTRY_APPENDED_SOURCE = 'compaction-entry-appended' as const

/** 落盘信号的判读结果（compactionId 缺失时 undefined，消费方走尾部兜底取最近 compaction entry）。 */
export interface CompactionPersistSignal { // oe-exempt:20261031:framework:extension-protocol 跨进程契约词表（写侧扩展 / 读侧 runtime 值依赖），协议契约层单实现合法
  compactionId?: string
}

/**
 * 防御性解析后台压缩落盘信号的 details（runtime 分诊判据，parseBgNotifyDetails 同款范式）。
 *
 * 命中 = source 为落盘信号词（customType 判定在消费方先行，本函数只裁 details）。
 * 非对象形态 / source 不符 → null（非目标信号）；compactionId 非串 → undefined（降级尾部兜底）。
 */
export function parseCompactionPersistSignal(details: unknown): CompactionPersistSignal | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null
  const d = details as Record<string, unknown>
  if (d.source !== COMPACTION_ENTRY_APPENDED_SOURCE) return null
  return { compactionId: typeof d.compactionId === 'string' ? d.compactionId : undefined }
}
