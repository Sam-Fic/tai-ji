/**
 * session.history 协议形状契约测试（turn-boundary-index D4 交付后本文件的承载内容）。
 *
 * 文件名沿用原登记路径（dev-flow 测试命令按此路径精确运行）；改写后承载两组断言：
 * ① session.history 读写形状核对（D4 红线：查询协议只删事件不改查询形状——请求
 *    cursor/limitTurns/maxBytes 可选参数与响应 messages/truncated/loadedTurns/
 *    totalTurnsEstimate 契约逐字段锁定）；
 * ② 通知帧退役负向断言——缓存就绪通知帧名不在 ServerMessageType 联合（类型层证明
 *    零生产者协议不回流：帧名回流 = Extract 命中非 never，编译红）。帧名在断言中以
 *    模板字面量类型拼接持有，防本文件被仓库级零回流检索命中（scripts
 *    check-history-read-model.mjs 组 1 同款口径）。
 * 纯契约层验证；runtime 读取编排（history-reader）与 renderer 消费点引用同一类型定义。
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import type { ClientMessageMap, ServerMessage, ServerMessageMap, ServerMessageType } from '../protocol'
// 跨包可达性：index.ts 对 protocol.ts 是显式 allowlist（非 export *），协议联合经包根
// 入口 re-export（ServerMessageType 在 allowlist 内）——下游消费方按同形状导入。
import type { ServerMessageType as ServerMessageTypeFromRoot } from '../index'
import type { Message } from '../message'
import type { SessionSummary } from '../session'

// 退役帧名 = 两段模板字面量类型的拼接（源码零完整字面量，类型层完整）。
const RETIRED_SEGMENTS = ['session.historyCache', 'Ready'] as const
type RetiredFrameName = `${(typeof RETIRED_SEGMENTS)[0]}${(typeof RETIRED_SEGMENTS)[1]}`

describe('session.history 协议形状契约（turn-boundary-index D4 查询形状不变）', () => {
  it('请求形状：cursor/limitTurns/maxBytes 三可选参数 + sessionId 必需（ClientMessageMap 登记逐字段）', () => {
    // 字段集与 optional 性锁定：新增/删除/必填化任一变化即编译红（D4 范围外红线）
    expectTypeOf<ClientMessageMap['session.history']>().toEqualTypeOf<{
      sessionId: string
      cursor?: string
      limitTurns?: number
      maxBytes?: number
    }>()
    // 可构造性：全参数帧（游标翻页形态）合法
    const page: ClientMessageMap['session.history'] = { sessionId: 's1', cursor: 'c8d048cb', limitTurns: 5, maxBytes: 64 }
    expect(page.sessionId).toBe('s1')
    expect(page.cursor).toBe('c8d048cb')
    // 缺省帧（最近窗口形态）合法且可选项省略后不可读出
    const recent: ClientMessageMap['session.history'] = { sessionId: 's1' }
    expect(recent.cursor).toBeUndefined()
    expect(recent.limitTurns).toBeUndefined()
    expect(recent.maxBytes).toBeUndefined()
  })

  it('响应形状：messages/truncated/loadedTurns/totalTurnsEstimate 必需 + session/interrupted 可选（ServerMessageMap 登记逐字段）', () => {
    expectTypeOf<ServerMessageMap['session.history']>().toEqualTypeOf<{
      sessionId: string
      session?: SessionSummary
      messages: Message[]
      truncated: boolean
      loadedTurns: number
      totalTurnsEstimate: number
      interrupted?: boolean
    }>()
    // 最小合法响应（最近窗口空页形态——零 turn 兼容分支的协议承载）
    const empty: ServerMessageMap['session.history'] = {
      sessionId: 's1',
      messages: [],
      truncated: false,
      loadedTurns: 0,
      totalTurnsEstimate: 0,
    }
    expect(empty.truncated).toBe(false)
    expect(empty.messages).toHaveLength(0)
    expect(empty.interrupted).toBeUndefined()
    // wire 帧构造（ServerMessage 泛型接口）：reply 型 session.history 帧合法
    const msg: ServerMessage<'session.history'> = {
      type: 'session.history',
      id: 'r1',
      payload: empty,
    }
    expect(msg.type).toBe('session.history')
    expect(msg.payload.totalTurnsEstimate).toBe(0)
  })

  it('退役负向断言：缓存就绪通知帧名不在 ServerMessageType（经包根入口同步核对——回流即 Extract 命中非 never 编译红）', () => {
    expectTypeOf<Extract<ServerMessageType, RetiredFrameName>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<ServerMessageTypeFromRoot, RetiredFrameName>>().toEqualTypeOf<never>()
  })
})
