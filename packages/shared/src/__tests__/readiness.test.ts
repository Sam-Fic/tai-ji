/**
 * readiness.test.ts — readiness 契约封闭性单测（startup-readiness-and-current-state 设计
 * §4.2 RL1，u-m0 M0 契约期 M0-2）。
 *
 * 看守对象：packages/shared/src/readiness.ts 形状 SSOT + protocol.ts 四消息登记。
 * 验证三组：
 *  - RL1 契约封闭：ReadinessSnapshot 顶层仅 capabilities 数组；能力项字段集 =
 *    name/ready/reason?/since/progress? 恰好五项——字段集外新增（进程生命周期 state
 *    字段等，v2 草案否决记录见设计 D1 不采用栏）即红。
 *  - §7.1 形状逐字段对账：RemoteCapability 四值 / ReadinessProgress / 能力项字段
 *    语义 / SessionsRecoveryProgressPayload。
 *  - protocol.ts 四消息登记（M0-1）：runtime.readiness RPC（request/reply 同名）+
 *    readinessChanged / sessionsRecoveryProgress 两广播；广播不是 RPC reply。
 *
 * 模式与 protocol-rolling-restart.test.ts / protocol-occupancy.test.ts 一致：
 * 编译期 AssertExtends 断言（tsc --noEmit 承载）+ 运行期对象字面量与白名单常量断言
 * （vitest 承载）。封闭性的「红」分两层：只改类型不改白名单常量 → 编译期对账断言红
 * （pnpm typecheck）；只改白名单常量不加字段 → satisfies 约束红 + 本文件运行期精确
 * 断言红（vitest run）。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/readiness.test.ts
 */
import { describe, it, expect } from 'vitest'
// 形状 SSOT 在 ./readiness；protocol.ts 仅登记 type→payload 映射（两处分开导入）。
import type {
  ReadinessCapabilityEntry,
  ReadinessProgress,
  ReadinessSnapshot,
  RemoteCapability,
  SessionsRecoveryProgressPayload,
} from '../readiness'
import type {
  ClientMessageMap,
  ClientMessageType,
  ReplyPayloadMap,
  ServerMessage,
  ServerMessageMap,
  ServerMessageType,
} from '../protocol'
import {
  READINESS_CAPABILITY_ENTRY_FIELDS,
  READINESS_REASON_CODES,
  READINESS_SNAPSHOT_FIELDS,
} from '../readiness'

// ── 编译期类型断言辅助（同 protocol-rolling-restart.test.ts 模式）────────
type AssertExtends<A, B> = A extends B ? true : ['ERROR: A does not extend B', A, B]
type AssertHasKey<T, K extends keyof T> = true
type AssertNotHasKey<T, K extends PropertyKey> = K extends keyof T ? ['ERROR: key present', K] : true

// ── RL1 编译期对账：能力项字段集封闭（双向锁定）────────────────────
// 方向一：keyof 集合 ⊆ 白名单——类型新增字段（如进程生命周期 state）而不改白名单 → 此行红。
type _Assert_CapabilityEntryKeysCovered = AssertExtends<
  keyof ReadinessCapabilityEntry,
  (typeof READINESS_CAPABILITY_ENTRY_FIELDS)[number]
>
// 方向二：白名单 ⊆ keyof 集合——白名单加字段而不改类型 → satisfies 约束红（readiness.ts 本体）。
type _Assert_FieldsAllDeclared = AssertExtends<
  (typeof READINESS_CAPABILITY_ENTRY_FIELDS)[number],
  keyof ReadinessCapabilityEntry
>
// 快照顶层仅 capabilities（RL1：capabilities 数组唯一——顶层新增维度即红）。
type _Assert_SnapshotKeysCovered = AssertExtends<
  keyof ReadinessSnapshot,
  (typeof READINESS_SNAPSHOT_FIELDS)[number]
>
type _Assert_SnapshotFieldsAllDeclared = AssertExtends<
  (typeof READINESS_SNAPSHOT_FIELDS)[number],
  keyof ReadinessSnapshot
>

// ── protocol.ts 四消息登记（编译期）──────────────────────────────
type _Assert_ReadinessRequest = AssertExtends<'runtime.readiness', ClientMessageType>
type _Assert_ReadinessRequestKey = AssertHasKey<ClientMessageMap, 'runtime.readiness'>
type _Assert_ReadinessReply = AssertExtends<'runtime.readiness', ServerMessageType>
type _Assert_ReadinessChanged = AssertExtends<'runtime.readinessChanged', ServerMessageType>
type _Assert_RecoveryProgress = AssertExtends<'runtime.sessionsRecoveryProgress', ServerMessageType>
// ServerMessage 泛型按 type 收窄后取到 ReadinessSnapshot（判别联合通路）。
type _Assert_ReadinessNarrowed = AssertExtends<ServerMessage<'runtime.readiness'>['payload'], ReadinessSnapshot>
type _Assert_ProgressNarrowed = AssertExtends<
  ServerMessage<'runtime.sessionsRecoveryProgress'>['payload'],
  SessionsRecoveryProgressPayload
>
// RPC reply 映射（payload 消费型）；两广播是推送帧不是 RPC reply——不在 ReplyPayloadMap。
type _Assert_ReadinessReplyMapped = AssertExtends<
  ReplyPayloadMap['runtime.readiness'],
  ServerMessageMap['runtime.readiness']
>
type _Assert_ReadinessChangedNotReply = AssertNotHasKey<ReplyPayloadMap, 'runtime.readinessChanged'>
type _Assert_ProgressNotReply = AssertNotHasKey<ReplyPayloadMap, 'runtime.sessionsRecoveryProgress'>

// ── 运行期断言 ────────────────────────────────────────────────
describe('RL1 契约封闭（startup-readiness-and-current-state §4.2）', () => {
  it('能力项字段集 = name/ready/reason/since/progress 恰好五项（字段集外新增即红）', () => {
    // 白名单常量是字段集的运行期唯一投影：给 ReadinessCapabilityEntry 加字段必须
    // 同批改这里才不红——「进程生命周期 state 字段回潮」（D1 否决记录）在 diff 层
    // 显式可见，且不改白名单时编译期对账断言（本文件顶部）即红。
    expect([...READINESS_CAPABILITY_ENTRY_FIELDS].sort()).toEqual(
      ['name', 'progress', 'ready', 'reason', 'since'].sort(),
    )
  })

  it('READINESS_REASON_CODES 四码封闭词表（dmg-r1-3）：reason 值域单源 + 测试形态对账', () => {
    // 词表 = reason 字段「机器可读枚举」声明的值域单源；新增原因码须同批改常量与设计。
    expect([...READINESS_REASON_CODES].sort()).toEqual(
      ['plugin_failed', 'plugins_loading', 'reattaching', 'recovering'].sort(),
    )
    // 本文件已出现的 reason 测试形态全部可由词表导出（plugin_failed 带前缀约定后缀）：
    // 'plugin_failed:demo-plugin' / 'recovering' / 'reattaching'。
    const reasonOf = (code: (typeof READINESS_REASON_CODES)[number], suffix?: string) =>
      suffix === undefined ? code : `${code}:${suffix}`
    expect(reasonOf('plugin_failed', 'demo-plugin')).toBe('plugin_failed:demo-plugin')
    for (const code of READINESS_REASON_CODES) {
      expect(READINESS_REASON_CODES).toContain(code)
    }
  })

  it('快照顶层仅 capabilities 数组（RL1：capabilities 数组唯一）', () => {
    expect([...READINESS_SNAPSHOT_FIELDS]).toEqual(['capabilities'])
  })

  it('进程生命周期 state 字段不进能力项（D1 不采用栏否决记录的回归看守）', () => {
    // v2 草案六值 state（spawning/listening/serving/draining/stopped/failed）已删除：
    // 白名单无 state 位；编译期哨兵（tsc 层红）见文件尾 _RL1_RejectsStateField。
    const whitelisted = READINESS_CAPABILITY_ENTRY_FIELDS as readonly string[]
    for (const stateValue of ['state', 'spawning', 'listening', 'serving', 'draining', 'stopped', 'failed']) {
      expect(whitelisted).not.toContain(stateValue)
    }
  })
})

describe('§7.1 形状逐字段对账（M0-1）', () => {
  it('RemoteCapability 四值闭集：transport/business/sessions/storage', () => {
    const all: RemoteCapability[] = ['transport', 'business', 'sessions', 'storage']
    expect(all).toHaveLength(4)
  })

  it('能力项：reason 可缺省、progress 可缺省、since 必填（数值时刻）', () => {
    const entries: ReadinessCapabilityEntry[] = [
      // 最小形态：reason/progress 均缺省（就绪态）
      { name: 'transport', ready: true, since: 1_700_000_000_000 },
      // reason 机器可读枚举 + 人可读文案（插件失败含插件 id，D2）
      { name: 'business', ready: false, reason: 'plugin_failed:demo-plugin', since: 0 },
      // progress 恢复进度 n/m（仅 sessions 恢复期出现，D11/R3）
      { name: 'sessions', ready: false, reason: 'recovering', since: 0, progress: { done: 3, total: 12 } },
    ]
    expect(entries[0].reason).toBeUndefined()
    expect(entries[0].progress).toBeUndefined()
    expect(typeof entries[0].since).toBe('number')
    expect(entries[2].progress).toEqual({ done: 3, total: 12 })
  })

  it('ReadinessProgress 形状 = { done; total }', () => {
    const progress: ReadinessProgress = { done: 0, total: 0 }
    expect(Object.keys(progress).sort()).toEqual(['done', 'total'])
  })

  it('SessionsRecoveryProgressPayload：reason 必填 + progress 缺省形态（跳过/退化懒恢复无计数）', () => {
    const payloads: SessionsRecoveryProgressPayload[] = [
      { reason: 'recovering' },
      { reason: 'reattaching', progress: { done: 5, total: 9 } },
    ]
    expect(payloads[0].progress).toBeUndefined()
    expect(payloads[1].progress).toEqual({ done: 5, total: 9 })
  })

  it('快照可构造：四能力全量形态', () => {
    const snapshot: ReadinessSnapshot = {
      capabilities: [
        { name: 'transport', ready: true, since: 1 },
        { name: 'business', ready: false, reason: 'plugins_loading', since: 2 },
        { name: 'sessions', ready: false, reason: 'recovering', since: 3, progress: { done: 1, total: 4 } },
        { name: 'storage', ready: true, since: 4 },
      ],
    }
    expect(snapshot.capabilities.map(c => c.name)).toEqual(['transport', 'business', 'sessions', 'storage'])
  })
})

describe('protocol.ts 四消息登记（M0-1，设计 §3.4 M0 登记清单）', () => {
  it('runtime.readiness 无参拉取 RPC：request/reply 同名登记', () => {
    const emptyRequest: ClientMessageMap['runtime.readiness'] = {}
    expect(Object.keys(emptyRequest)).toHaveLength(0)
    expect('runtime.readiness' satisfies ClientMessageType).toBe('runtime.readiness')
    expect('runtime.readiness' satisfies ServerMessageType).toBe('runtime.readiness')
  })

  it('两广播帧走 Server→Client 全局帧命名（无 sessionId，纯全局通道先例 mcp:testResult）', () => {
    const pushTypes: ServerMessageType[] = ['runtime.readinessChanged', 'runtime.sessionsRecoveryProgress']
    for (const type of pushTypes) expect(type).toMatch(/^runtime\./)
    expect(pushTypes).toHaveLength(2)
  })

  it('ServerMessageMap 三条目 payload 形状：两快照同型 + 进度通知载荷', () => {
    const reply: ServerMessageMap['runtime.readiness'] = { capabilities: [] }
    const changed: ServerMessageMap['runtime.readinessChanged'] = { capabilities: [] }
    const progress: ServerMessageMap['runtime.sessionsRecoveryProgress'] = { reason: 'recovering' }
    expect(reply).toEqual(changed)
    expect(Object.keys(progress).sort()).toEqual(['reason'])
  })

  it('两广播不在 ReplyPayloadMap（是广播不是 RPC reply，运行期不可枚举类型键，编译期断言承载）', () => {
    // TC5 同款：推送事件键的存在性由编译期 AssertNotHasKey 保证，此处锚定登记面收敛。
    expect(READINESS_SNAPSHOT_FIELDS).toHaveLength(1)
  })
})

// ── 编译期哨兵：能力项字段集外字段必须被 TS 拒绝（excess property check）────────
// tsc 层红通道：若有人给 ReadinessCapabilityEntry 加索引签名（放宽为开放字段集），
// 下方 _RL1_RejectsStateField 的对象字面量不再报 excess property 错 → @ts-expect-error
// 变为未使用指令 → pnpm typecheck 红。esbuild/vitest 运行期无类型检查，该哨兵的红由
// typecheck 承载（testCommand 之外，验收证据另行跑 typecheck，见交付说明）。
const _RL1_RejectsStateField: ReadinessCapabilityEntry = {
  name: 'transport',
  ready: true,
  since: 0,
  // @ts-expect-error RL1：state 是 v2 草案已否决的进程生命周期字段（D1 不采用栏），
  // 能力项字段集封闭——字段集外属性必须保持编译期红。
  state: 'serving',
}
void _RL1_RejectsStateField
