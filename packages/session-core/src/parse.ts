/**
 * JSONL 解析原语：session JSONL 文本/文件 → canonical entries。
 *
 * 坏行语义（严格模型，设计 D1）：逐行 JSON.parse，语法错误或缺必填结构字段计入
 * skippedLines 并丢弃，不占位、不中断整体解析。宽松「坏行保留占位」形态是
 * core/session-trace 的私有语义（设计 D1 不采用项），不进本基座。
 *
 * 非法 message role 不走坏行容错：message 存在但 role 不在 SESSION_MESSAGE_ROLES
 * 词表时整文件解析抛 UnknownMessageRoleError（fail-fast）。词表外 role 意味着写入方
 * pi 版本较本包词表更新，静默丢 message 会造成会话内容不可见地损失——显式失败优于
 * 静默丢内容（用户裁决 2026-10-30），扩展词表（升级）后即恢复可读。
 */

import { readFile } from 'node:fs/promises'

import { SESSION_MESSAGE_ROLES, type Entry, type ParseResult, type SessionMessageRole } from './types.js'

/**
 * message.role 不在合法词表时的解析错误（fail-fast 通道）：整文件解析抛出，
 * 不折叠进 skippedLines、不产出丢弃 message 的空壳 entry。
 */
export class UnknownMessageRoleError extends Error {
  /** 非法行所在行号（1-based，与编辑器行号一致） */
  readonly line: number
  /** 该行 message.role 的原始值（缺失时为 undefined） */
  readonly role: unknown

  constructor(line: number, role: unknown) {
    super(
      `session JSONL 第 ${line} 行 message.role 非法：${JSON.stringify(role) ?? String(role)}` +
        `（合法值：${SESSION_MESSAGE_ROLES.join('/')}）。` +
        `👉 该行内容不会被静默丢弃：写入方 pi 版本可能较新（新增 role 而本包词表未收录），` +
        `升级 taiji 后重试，或人工修复该行的 role 字段。`,
    )
    this.name = 'UnknownMessageRoleError'
    this.line = line
    this.role = role
  }
}

/** role 值检查：取数源 = SESSION_MESSAGE_ROLES（词表值清单，扩展点见该常量注释的穷尽断言）。 */
function isMessageRole(v: unknown): v is SessionMessageRole {
  return (SESSION_MESSAGE_ROLES as readonly string[]).includes(v as string)
}

/**
 * 归一化 message 字段：role 经值检查收窄。message 不存在（或非对象）时返回
 * undefined，entry 照常产出（message 缺省）；message 存在但 role 不在词表时抛
 * UnknownMessageRoleError（fail-fast，不静默丢 message）。
 */
function parseEntryMessage(raw: unknown, line: number): Entry['message'] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const m = raw as Record<string, unknown>
  if (!isMessageRole(m.role)) throw new UnknownMessageRoleError(line, m.role)
  const message: NonNullable<Entry['message']> = { role: m.role, content: m.content }
  if (Array.isArray(m.toolCalls)) message.toolCalls = m.toolCalls
  if (typeof m.toolName === 'string') message.toolName = m.toolName
  if (typeof m.toolCallId === 'string') message.toolCallId = m.toolCallId
  return message
}

/** 归一化剩余可选字段（customType/data/parentSession/cwd/summary）。 */
function assignOptionalFields(obj: Record<string, unknown>, entry: Entry): void {
  if (typeof obj.customType === 'string') entry.customType = obj.customType
  if (obj.data !== undefined) entry.data = obj.data
  if (typeof obj.parentSession === 'string') entry.parentSession = obj.parentSession
  if (typeof obj.cwd === 'string') entry.cwd = obj.cwd
  if (obj.summary !== undefined) entry.summary = obj.summary
}

/**
 * 把单个已 JSON.parse 成功的原始对象归一化为 Entry。
 * 缺必填结构字段（type/id）返回 undefined，调用方计为坏行（skippedLines++）；
 * message 存在但 role 非法时抛 UnknownMessageRoleError（见模块注释）。
 *
 * id 取顶层 id（pi appendCustomEntry 恒写顶层 id）；data.id 是扩展业务字段
 * （如 subagent-identity payload），不是 entry id，不做 fallback。
 */
function toEntry(raw: unknown, line: number): Entry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj.type !== 'string') return undefined
  const id: unknown = obj.id
  if (typeof id !== 'string') return undefined

  const entry: Entry = {
    type: obj.type,
    id,
    parentId: typeof obj.parentId === 'string' ? obj.parentId : null,
  }
  if (typeof obj.timestamp === 'string') entry.timestamp = obj.timestamp

  const message = parseEntryMessage(obj.message, line)
  if (message !== undefined) entry.message = message

  assignOptionalFields(obj, entry)

  return entry
}

/**
 * 解析 session JSONL 文本为 entries。
 *
 * 末尾换行产生的空行忽略（不计 skipped）；中间空行容错跳过
 * （正常 JSONL 无空行，防御文件损坏）。
 */
export function parseSessionContent(content: string): ParseResult {
  const entries: Entry[] = []
  let skippedLines = 0

  const lines = content.split('\n')
  // 移除末尾因 trailing newline 产生的空行（非真实行）
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 中间空行容错：不计 skipped
    if (line.trim() === '') continue

    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      skippedLines++
      continue
    }

    const entry = toEntry(raw, i + 1)
    if (entry === undefined) {
      skippedLines++
      continue
    }
    entries.push(entry)
  }

  return {
    entries,
    skippedLines,
    totalBytes: Buffer.byteLength(content, 'utf8'),
  }
}

/** 读取 session 文件并解析。文件不存在按 Node fs 原生错误抛出（ENOENT）。 */
export async function parseSessionFile(filePath: string): Promise<ParseResult> {
  const content = await readFile(filePath, 'utf8')
  return parseSessionContent(content)
}
