/**
 * M0 契约词表锁定测试：状态/命令/通知/结果/告警封闭词表 + 状态机转移谓词 + 失联告警构造。
 *
 * 定位（M0-1 契约测试基线的一部分，与 fields.test.ts / baseline.test.ts 分工对账）：
 * - 词表 toEqual 精确锁定 = 契约级终态裁决第 5 项「终局结算直接继承现行词表、不许重设计」
 *   的可执行载体——词表任何增删都会在这里红，迫使同批更新契约与设计文档；
 * - 转移谓词按源码声明的合法转移表逐条断言（表内 true、表外抽样 false）；
 * - 断言口径 = 源码实际实现；发现与设计不一致时改测试口径须先过设计裁决，不静默跟源码。
 */

import { describe, expect, it } from 'vitest'

import {
  EXECUTION_ALERT_CODES,
  buildContactLostAlert,
} from '../alerts'
import { COLLECT_KEY_SOURCES } from '../collect-results'
import {
  CONTROL_METHOD_NAMESPACES,
  EXECUTION_COMMAND_ERROR_CODES,
  EXECUTION_COMMAND_NAMES,
} from '../commands'
import {
  EXECUTION_AGGREGATE_TYPES,
  MEMBER_CLOSED_REASONS,
  isExecutionEventType,
} from '../events'
import {
  NOTICE_CONSUMERS,
  NOTICE_STATUSES,
  NOTICE_TYPES,
  isTerminalNoticeStatus,
} from '../notice'
import { RESULT_STATUSES } from '../result'
import {
  ATTEMPT_OUTCOMES,
  ATTEMPT_STATUSES,
  DISPATCH_ORIGINS,
  MEMBER_MODES,
  MEMBER_STATUSES,
  RUN_PAUSE_CAUSES,
  RUN_STATUSES,
  STEP_STATUSES,
  canTransitionAttempt,
  canTransitionMember,
  canTransitionStep,
  isClosedMemberStatus,
} from '../status'

// ── 类型级编译锁：全部词表必须是只读字符串数组（源码 as const；运行级未 Object.freeze， ──
// ── 不可变性由类型系统在编译期强制，运行级不做 isFrozen 断言）──
type AssertReadonlyStringArray<T extends readonly string[]> = true
type _AllLexiconsAreReadonlyArrays = AssertReadonlyStringArray<
  | typeof RUN_STATUSES
  | typeof MEMBER_STATUSES
  | typeof ATTEMPT_STATUSES
  | typeof ATTEMPT_OUTCOMES
  | typeof STEP_STATUSES
  | typeof RUN_PAUSE_CAUSES
  | typeof DISPATCH_ORIGINS
  | typeof MEMBER_MODES
  | typeof RESULT_STATUSES
  | typeof NOTICE_TYPES
  | typeof NOTICE_STATUSES
  | typeof NOTICE_CONSUMERS
  | typeof MEMBER_CLOSED_REASONS
  | typeof EXECUTION_AGGREGATE_TYPES
  | typeof EXECUTION_COMMAND_NAMES
  | typeof EXECUTION_COMMAND_ERROR_CODES
  | typeof CONTROL_METHOD_NAMESPACES
  | typeof COLLECT_KEY_SOURCES
  | typeof EXECUTION_ALERT_CODES
>

/** 词表锁定统一口径：内容逐项相等（精确锁）+ 无重复项（防期望数组自身写重时双错抵消）。 */
function expectExactLexicon(actual: readonly string[], expected: readonly string[]): void {
  expect(actual).toEqual(expected)
  expect(new Set(actual).size).toBe(actual.length)
}

describe('执行域封闭词表逐项锁定（继承现行词表，禁重设计）', () => {
  it('Run 生命周期状态与暂停原因词表', () => {
    expectExactLexicon([...RUN_STATUSES], [
      'created',
      'running',
      'interrupted',
      'done',
      'failed',
      'cancelled',
      'time_limited',
      'partially_succeeded',
    ])
    expectExactLexicon([...RUN_PAUSE_CAUSES], ['startup_sweep', 'engine_disconnected', 'parent_exited'])
  })

  it('Step 状态词表（无 Run 级聚合词 partially_succeeded）', () => {
    expectExactLexicon([...STEP_STATUSES], [
      'scheduled',
      'running',
      'done',
      'failed',
      'cancelled',
      'time_limited',
    ])
  })

  it('Attempt 状态与终局词表', () => {
    expectExactLexicon([...ATTEMPT_STATUSES], ['running', 'settled', 'interrupted'])
    expectExactLexicon([...ATTEMPT_OUTCOMES], ['done', 'failed', 'cancelled', 'time_limited'])
  })

  it('Member 状态 / 模式 / 关闭原因词表', () => {
    expectExactLexicon([...MEMBER_STATUSES], ['running', 'idle', 'closed'])
    expectExactLexicon([...MEMBER_MODES], ['interactive', 'one-shot'])
    expectExactLexicon([...MEMBER_CLOSED_REASONS], ['user', 'parent'])
  })

  it('派发方式词表（契约级终态裁决第 11 项：旧 RecordOrigin 正名为 manual / script）', () => {
    expectExactLexicon([...DISPATCH_ORIGINS], ['manual', 'script'])
  })

  it('结果工件终局状态词表', () => {
    expectExactLexicon([...RESULT_STATUSES], ['done', 'failed', 'cancelled', 'time_limited'])
  })

  it('通知类型 / 状态 / 消费方词表', () => {
    expectExactLexicon([...NOTICE_TYPES], ['run_settled', 'member_result'])
    expectExactLexicon([...NOTICE_STATUSES], ['pending', 'delivered', 'collected', 'abandoned'])
    expectExactLexicon([...NOTICE_CONSUMERS], ['agent'])
  })

  it('执行事件聚合类型词表（只有 run / member 两类聚合根，禁止第三类）', () => {
    expectExactLexicon([...EXECUTION_AGGREGATE_TYPES], ['run', 'member'])
  })

  it('执行 API 命令名词表（11 项；顺序对齐设计 §3.1 执行 API 表）', () => {
    expectExactLexicon([...EXECUTION_COMMAND_NAMES], [
      'run.start',
      'member.start',
      'member.send',
      'run.resume',
      'run.cancel',
      'member.cancel',
      'member.close',
      'snapshot.get',
      'result.get',
      'notice.ack',
      'notice.collect',
    ])
  })

  it('命令错误码词表（11 项封闭）', () => {
    expectExactLexicon([...EXECUTION_COMMAND_ERROR_CODES], [
      'invalid_params',
      'run_not_found',
      'run_not_interrupted',
      'resume_script_mismatch',
      'member_not_found',
      'member_not_interactive',
      'member_closed',
      'notice_not_found',
      'notice_not_delivered',
      'budget_hard_limit_exceeded',
      'internal_error',
    ])
  })

  it('控制通道语义层方法名空间词表（D10；执行 API 命令名不加上下文前缀）', () => {
    expectExactLexicon([...CONTROL_METHOD_NAMESPACES], ['engine', 'state', 'domain'])
  })

  it('collect 键来源词表（执行域权威路 / 旧 pending 过渡路）', () => {
    expectExactLexicon([...COLLECT_KEY_SOURCES], ['execution', 'pending'])
  })

  it('结构化告警码词表（当前唯一成员 = 失联宽限超时）', () => {
    expectExactLexicon([...EXECUTION_ALERT_CODES], ['contact_lost_grace_exceeded'])
  })
})

describe('状态机转移谓词（表驱动；表内 true、表外 false，表外由调用方 fail-fast）', () => {
  it('canTransitionStep：调度后最多一次启动，终局只进一次', () => {
    expect(canTransitionStep('scheduled', 'running')).toBe(true)
    expect(canTransitionStep('scheduled', 'cancelled')).toBe(true)
    expect(canTransitionStep('running', 'done')).toBe(true)
    expect(canTransitionStep('running', 'failed')).toBe(true)
    expect(canTransitionStep('running', 'cancelled')).toBe(true)
    expect(canTransitionStep('running', 'time_limited')).toBe(true)
  })

  it('canTransitionStep：表外转移拒绝（终局无后继、无自环、不可回退）', () => {
    expect(canTransitionStep('scheduled', 'done')).toBe(false)
    expect(canTransitionStep('running', 'scheduled')).toBe(false)
    expect(canTransitionStep('running', 'running')).toBe(false)
    expect(canTransitionStep('done', 'failed')).toBe(false)
    expect(canTransitionStep('cancelled', 'running')).toBe(false)
    expect(canTransitionStep('time_limited', 'done')).toBe(false)
  })

  it('canTransitionMember：running/idle 可互转并可达 closed', () => {
    expect(canTransitionMember('running', 'idle')).toBe(true)
    expect(canTransitionMember('running', 'closed')).toBe(true)
    expect(canTransitionMember('idle', 'running')).toBe(true)
    expect(canTransitionMember('idle', 'closed')).toBe(true)
  })

  it('canTransitionMember：closed 无后继、无自环（关闭只中断当前轮次，不删除历史结果）', () => {
    expect(canTransitionMember('closed', 'idle')).toBe(false)
    expect(canTransitionMember('closed', 'running')).toBe(false)
    expect(canTransitionMember('closed', 'closed')).toBe(false)
    expect(canTransitionMember('running', 'running')).toBe(false)
    expect(canTransitionMember('idle', 'idle')).toBe(false)
  })

  it('canTransitionAttempt：running 可进 settled / interrupted，终态只进一次', () => {
    expect(canTransitionAttempt('running', 'settled')).toBe(true)
    expect(canTransitionAttempt('running', 'interrupted')).toBe(true)
  })

  it('canTransitionAttempt：settled / interrupted 无后继、无自环', () => {
    expect(canTransitionAttempt('settled', 'interrupted')).toBe(false)
    expect(canTransitionAttempt('interrupted', 'running')).toBe(false)
    expect(canTransitionAttempt('settled', 'settled')).toBe(false)
    expect(canTransitionAttempt('running', 'running')).toBe(false)
  })
})

describe('谓词守卫（收窄与终态判定）', () => {
  it('isExecutionEventType：21 个过去式事件名内 true，词表外 false', () => {
    expect(isExecutionEventType('RunCreated')).toBe(true)
    expect(isExecutionEventType('NoticeAbandoned')).toBe(true)
    expect(isExecutionEventType('run.created')).toBe(false)
    expect(isExecutionEventType('RunCreatedExtra')).toBe(false)
    expect(isExecutionEventType('')).toBe(false)
  })

  it('isTerminalNoticeStatus：collected / abandoned 终局，pending / delivered 仍在处理中', () => {
    expect(isTerminalNoticeStatus('collected')).toBe(true)
    expect(isTerminalNoticeStatus('abandoned')).toBe(true)
    expect(isTerminalNoticeStatus('pending')).toBe(false)
    expect(isTerminalNoticeStatus('delivered')).toBe(false)
  })

  it('isClosedMemberStatus：closed 是唯一关闭态', () => {
    expect(isClosedMemberStatus('closed')).toBe(true)
    expect(isClosedMemberStatus('running')).toBe(false)
    expect(isClosedMemberStatus('idle')).toBe(false)
  })
})

describe('失联宽限结构化告警构造（观测告警，不判死）', () => {
  it('buildContactLostAlert 返回七字段结构化载荷，detail 逐字段透传入参', () => {
    const alert = buildContactLostAlert({
      sessionId: 'session-1',
      contactLostAt: 1_760_000_000_000,
      graceMs: 60_000,
      latestRevision: 7,
      observedAt: 1_760_000_060_000,
    })

    expect(Object.keys(alert).sort()).toEqual([
      'code',
      'detail',
      'event',
      'message',
      'observedAt',
      'recovery',
      'sessionId',
    ])
    expect(alert.event).toBe('execution.alert')
    expect(alert.code).toBe('contact_lost_grace_exceeded')
    expect(alert.sessionId).toBe('session-1')
    expect(alert.observedAt).toBe(1_760_000_060_000)
    expect(alert.detail).toEqual({
      contactLostAt: 1_760_000_000_000,
      graceMs: 60_000,
      latestRevision: 7,
    })
  })

  it('告警文案携带宽限阈值事实与恢复动作（不改变 run 终态的语义进 message）', () => {
    const alert = buildContactLostAlert({
      sessionId: 'session-1',
      contactLostAt: 1_760_000_000_000,
      graceMs: 60_000,
      latestRevision: 7,
      observedAt: 1_760_000_060_000,
    })

    expect(alert.message).toContain('失联超过宽限 60000ms')
    expect(alert.message).toContain('告警不改变 run 终态')
    expect(alert.recovery.length).toBeGreaterThan(0)
  })
})
