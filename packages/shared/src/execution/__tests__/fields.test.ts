/**
 * M0-1 契约测试基线：事件 / 快照 / 结果 / 通知四组字段与设计 §5.2「双形态契约字段级
 * 单一权威」逐字段对账。
 *
 * 对账方式双保险：
 * - 运行级：构造样例对象，断言 Object.keys 与设计字段清单逐项相等（防运行时多字段）；
 * - 类型级：ExactKeys 编译锁（防接口悄悄扩字段却漏登记）。
 *
 * 设计字段清单在此处**作为检查常量**出现（测试的职责就是锁设计），生产侧不复制第二份。
 */

import { describe, expect, it } from 'vitest'

import type { ExecutionEvent } from '../events'
import { EXECUTION_EVENT_TYPES, EXECUTION_EVENT_CONTRACT_VERSION, NOTICE_ABANDONED_REASONS } from '../events'
import type { NoticeIntent } from '../notice'
import { NOTICE_STATUS_TRANSITIONS, canTransitionNotice, isNoticeOutOfCollectSet } from '../notice'
import type { ResultArtifact, ResultArtifactFields } from '../result'
import type { ExecutionSnapshot } from '../snapshot'
import {
  RUN_OUTCOMES,
  RUN_STATUS_TRANSITIONS,
  canTransitionRun,
  isTerminalRunStatus,
} from '../status'
import { WORKFLOW_RUN_OUTCOME_ALL } from '../../workflow'

type ExactKeys<T, U extends keyof T> = Exclude<keyof T, U> extends never ? true : never
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T]
type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T]
type ExactUnion<T, U extends T> = Exclude<T, U> extends never ? true : never
type AssertNever<T extends never> = true

const DESIGN_EVENT_OUTER_FIELDS = [
  'v',
  'sessionId',
  'seq',
  'eventId',
  'aggregateType',
  'aggregateId',
  'type',
  'commandId',
  'timestamp',
  'payload',
] as const

const DESIGN_SNAPSHOT_OUTER_FIELDS = ['sessionId', 'revision', 'generation', 'runs', 'members'] as const

const DESIGN_RESULT_FIELDS = [
  'resultId',
  'runId',
  'memberId',
  'stepKey',
  'attemptId',
  'status',
  'content',
  'error',
  'usage',
  'engine',
] as const

const DESIGN_NOTICE_FIELDS = ['noticeId', 'type', 'refId', 'consumer', 'status', 'attempt'] as const

// ── 类型级编译锁（字段缺失由 U 约束拦截；字段多出由 ExactKeys 变 never 拦截） ──
type _EventOuterExact = ExactKeys<ExecutionEvent, (typeof DESIGN_EVENT_OUTER_FIELDS)[number]>
type _SnapshotOuterExact = ExactKeys<ExecutionSnapshot, (typeof DESIGN_SNAPSHOT_OUTER_FIELDS)[number]>
type _ResultExact = ExactKeys<ResultArtifact, (typeof DESIGN_RESULT_FIELDS)[number]>
type _NoticeExact = ExactKeys<NoticeIntent, (typeof DESIGN_NOTICE_FIELDS)[number]>
type _SnapshotHasNoNotices = 'notices' extends keyof ExecutionSnapshot ? never : true

// ── 类型级可选性锁（设计字段说明里的可选标记必须与接口一致） ──
// 事件外层：只有 commandId 可选（故障路径事件不带命令 id）。
type _EventOptionalExact = ExactUnion<OptionalKeys<ExecutionEvent>, 'commandId'>
type _EventRequiredExact = ExactUnion<
  RequiredKeys<ExecutionEvent>,
  Exclude<(typeof DESIGN_EVENT_OUTER_FIELDS)[number], 'commandId'>
>
// 快照 / 通知：六字段与五字段全部必填（无可选标记）。
type _SnapshotNoOptional = AssertNever<OptionalKeys<ExecutionSnapshot>>
type _NoticeNoOptional = AssertNever<OptionalKeys<NoticeIntent>>
// 结果工件公共面：resultId/status/content 必填；stepKey/attemptId/error/usage/engine 可选。
type _ResultFieldsOptionalExact = ExactUnion<
  OptionalKeys<ResultArtifactFields>,
  'stepKey' | 'attemptId' | 'error' | 'usage' | 'engine'
>
type _ResultFieldsRequiredExact = ExactUnion<RequiredKeys<ResultArtifactFields>, 'resultId' | 'status' | 'content'>

function eventsOuterKeysOf(sample: ExecutionEvent): string[] {
  return Object.keys(sample)
}

const sampleRunCreated: ExecutionEvent = {
  v: EXECUTION_EVENT_CONTRACT_VERSION,
  sessionId: 'session-1',
  seq: 1,
  eventId: 'event-1',
  aggregateType: 'run',
  aggregateId: 'run-1',
  type: 'RunCreated',
  commandId: 'command-1',
  timestamp: 1_760_000_000_000,
  payload: {
    runId: 'run-1',
    scriptPath: 'workflows/review.js',
    scriptHash: 'abc123',
    paramsHash: 'params-1',
  },
}

const sampleSnapshot: ExecutionSnapshot = {
  sessionId: 'session-1',
  revision: 1,
  generation: 1,
  runs: [],
  members: [],
}

const sampleResult: ResultArtifact = {
  resultId: 'result-1',
  runId: 'run-1',
  memberId: undefined,
  stepKey: undefined,
  attemptId: undefined,
  status: 'done',
  content: 'ok',
  error: undefined,
  usage: undefined,
  engine: undefined,
}

const sampleNotice: NoticeIntent = {
  noticeId: 'notice-1',
  type: 'run_settled',
  refId: 'run-1',
  consumer: 'agent',
  status: 'pending',
  attempt: 0,
}

describe('M0-1 契约字段逐字段对账（设计 §5.2 双形态契约字段级单一权威）', () => {
  it('事件外层十字段与设计清单逐项相等', () => {
    expect(eventsOuterKeysOf(sampleRunCreated).sort()).toEqual([...DESIGN_EVENT_OUTER_FIELDS].sort())
  })

  it('事件类型清单 = 设计 §3.1 领域事件 21 项（增删即契约定变更）', () => {
    expect(EXECUTION_EVENT_TYPES).toEqual([
      'RunCreated',
      'RunStarted',
      'RunPaused',
      'RunResumed',
      'RunSettled',
      'StepScheduled',
      'StepStarted',
      'StepSettled',
      'StepCancelled',
      'MemberCreated',
      'MemberTurnStarted',
      'MemberIdle',
      'MemberClosed',
      'AttemptStarted',
      'AttemptSettled',
      'AttemptInterrupted',
      'ResultRecorded',
      'NoticeQueued',
      'NoticeDelivered',
      'NoticeCollected',
      'NoticeAbandoned',
    ])
  })

  it('快照外层五字段与设计清单逐项相等，且不得增设 notices 字段', () => {
    expect(Object.keys(sampleSnapshot).sort()).toEqual([...DESIGN_SNAPSHOT_OUTER_FIELDS].sort())
    expect(sampleSnapshot).not.toHaveProperty('notices')
    expect(sampleSnapshot).not.toHaveProperty('contactLostAt')
  })

  it('结果工件十字段与设计清单逐项相等', () => {
    expect(Object.keys(sampleResult).sort()).toEqual([...DESIGN_RESULT_FIELDS].sort())
  })

  it('通知六字段与设计清单逐项相等', () => {
    expect(Object.keys(sampleNotice).sort()).toEqual([...DESIGN_NOTICE_FIELDS].sort())
  })

  it('结果工件要求 runId / memberId 至少一个（类型约束的运行级样例）', () => {
    const memberOnly: ResultArtifact = { resultId: 'result-2', memberId: 'member-1', status: 'done', content: null }
    expect(memberOnly.memberId).toBe('member-1')
    expect(memberOnly.runId).toBeUndefined()
  })
})

describe('状态词表与状态机（设计 §3.1 不变量 + 契约级终态裁决第 5 项继承）', () => {
  it('Run 终局词表逐项继承现行 WORKFLOW_RUN_OUTCOME_ALL（禁止重写另立词表）', () => {
    expect([...RUN_OUTCOMES]).toEqual([...WORKFLOW_RUN_OUTCOME_ALL])
  })

  it('Run 状态机：created 只能进 running；interrupted 可回 running 或终局；终局无后继', () => {
    expect(RUN_STATUS_TRANSITIONS.created).toEqual(['running'])
    expect([...RUN_STATUS_TRANSITIONS.interrupted].sort()).toEqual(['running', ...RUN_OUTCOMES].sort())
    for (const outcome of RUN_OUTCOMES) {
      expect(RUN_STATUS_TRANSITIONS[outcome]).toEqual([])
    }
    expect(canTransitionRun('running', 'interrupted')).toBe(true)
    expect(canTransitionRun('done', 'running')).toBe(false)
  })

  it('终局判定只认终局词表成员', () => {
    expect(isTerminalRunStatus('interrupted')).toBe(false)
    expect(isTerminalRunStatus('partially_succeeded')).toBe(true)
  })

  it('通知状态机：pending → delivered → collected 链式 + pending → abandoned；collected 无自环', () => {
    expect(NOTICE_STATUS_TRANSITIONS).toEqual({
      pending: ['delivered', 'abandoned'],
      delivered: ['collected'],
      collected: [],
      abandoned: [],
    })
    expect(canTransitionNotice('delivered', 'collected')).toBe(true)
    expect(canTransitionNotice('collected', 'collected')).toBe(false)
    expect(canTransitionNotice('pending', 'collected')).toBe(false)
  })

  it('abandoned 合法起点仅为 pending（delivered 后失败保留重试，不放弃）', () => {
    for (const status of ['delivered', 'collected', 'abandoned'] as const) {
      expect(NOTICE_STATUS_TRANSITIONS[status]).not.toContain('abandoned')
    }
    expect(NOTICE_ABANDONED_REASONS).toEqual(['delivery_retries_exhausted'])
  })

  it('abandoned 通知不进等待与收集集', () => {
    expect(isNoticeOutOfCollectSet('abandoned')).toBe(true)
    expect(isNoticeOutOfCollectSet('delivered')).toBe(false)
  })
})
