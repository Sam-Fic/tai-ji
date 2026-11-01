/**
 * data-source-registry.test.ts — 数据源登记表 schema 契约测试
 * （startup-readiness-and-current-state 设计 §7.4，u-m0 M0 契约期 M0-3）。
 *
 * 看守对象：packages/core/src/transport/data-source-registry.ts 形状 SSOT。
 * 验证三组：
 *  - DataSourceDescriptor §7.4 形状逐字段（id/scope/requires/load/failure/settle?）
 *  - requires 引用 shared RemoteCapability（跨包契约，u-m0→u-m2 契约先行的编译消费面）
 *  - 加载态字段形态 batchInProgress?（D10 概念入 M0 契约）在位；修订号字段不落
 *    （归重写侧同窗口对齐，只引用不实现——data-source-registry.ts 头注）。
 *
 * 模式同 shared 契约封闭性单测先例：编译期 AssertExtends + 运行期字面量构造断言。
 * 实装随 u-m2（quota presets 首个数据源接入）/ u-m3（主体搬迁）交付；本测试锁形状。
 *
 * 运行：cd packages/core && npx vitest run src/transport
 */
import { describe, it, expect } from 'vitest'
import type { RemoteCapability } from '@taiji/shared'
import type { DataSourceDescriptor, DataSourcePayloadFields } from '../data-source-registry'

// ── 编译期类型断言辅助 ─────────────────────────────────────────
type AssertExtends<A, B> = A extends B ? true : ['ERROR: A does not extend B', A, B]
type AssertAssignable<A, B> = B extends A ? true : ['ERROR: B not assignable to A', A, B]

// requires 元素联合 = RemoteCapability 四值 + 本地依赖维度两值（设计 §7.1：本地维度在 core 组合）
type RequiresItem = DataSourceDescriptor['requires'][number]
type _Assert_RemoteCapabilities = AssertExtends<RequiresItem, RemoteCapability | 'focusedSession' | 'viewOpen'>
type _Assert_LocalDimensionsAccepted = AssertAssignable<RequiresItem, 'transport' | 'business' | 'sessions' | 'storage' | 'focusedSession' | 'viewOpen'>

// failure 值域锁定：keep-old-warn 唯一值（拉取失败保留旧数据并告警）
type _Assert_FailureDomain = AssertExtends<DataSourceDescriptor['failure'], 'keep-old-warn'>

// scope 值域锁定
type _Assert_ScopeDomain = AssertExtends<DataSourceDescriptor['scope'], 'global' | 'session'>

// 加载态字段形态在位（batchInProgress? 可缺省布尔）
type _Assert_LoadingStateField = AssertExtends<DataSourcePayloadFields['batchInProgress'], boolean | undefined>

// ── 编译期强制执行点（AssertExtends/AssertAssignable 须经泛型约束消费才被 tsc 机器强制）──
// TS 对未被消费的类型别名不做诊断（断言失败解析为 ERROR 元组仍零报错，tsc --noEmit 全绿）——
// 上面各断言别名必须经泛型约束消费，设计 §7.4 的值域锁定才真正承载机器看守。任一值域
// 漂移（failure 加第二值 / requires 混入设计外维度 / scope 增值 / 载体字段漂移）→ 对应行
// TS2344（ERROR 元组带出双方类型，可读）。运行期仅返回常量 true，零成本。
// （模式同 shared 契约封闭性先例 plan-protocol.test.ts / gen-stats.test.ts。）
const _enforceTrue = <T extends true>(_v?: T): true => true
const _dataSourceRegistryAssertsEnforced = [
  _enforceTrue<_Assert_RemoteCapabilities>(),
  _enforceTrue<_Assert_LocalDimensionsAccepted>(),
  _enforceTrue<_Assert_FailureDomain>(),
  _enforceTrue<_Assert_ScopeDomain>(),
  _enforceTrue<_Assert_LoadingStateField>(),
]

// ── 运行期断言 ────────────────────────────────────────────────
describe('DataSourceDescriptor §7.4 形状（u-m0 M0-3）', () => {
  it('拉取型描述符可构造：requires 引用 RemoteCapability + 本地维度', async () => {
    const descriptor: DataSourceDescriptor = {
      id: 'quota-presets',
      scope: 'global',
      requires: ['transport', 'business'],
      load: async () => {},
      failure: 'keep-old-warn',
    }
    expect(descriptor.id).toBe('quota-presets')
    expect(descriptor.scope).toBe('global')
    expect(descriptor.requires).toEqual(['transport', 'business'])
    await descriptor.load()
    expect(descriptor.failure).toBe('keep-old-warn')
    expect(descriptor.settle).toBeUndefined()
  })

  it('requires 四能力值 + 两本地维度全部合法', () => {
    const requires: DataSourceDescriptor['requires'] = [
      'transport',
      'business',
      'sessions',
      'storage',
      'focusedSession',
      'viewOpen',
    ]
    expect(requires).toHaveLength(6)
  })

  it('settle?: 仅启动编排真要等的数据源声明（project 域先例语义）', () => {
    const settling: DataSourceDescriptor = {
      id: 'project',
      scope: 'global',
      requires: ['transport'],
      load: async () => {},
      failure: 'keep-old-warn',
      settle: true,
    }
    expect(settling.settle).toBe(true)
  })
})

describe('数据源读载体公共字段形态（M0 契约）', () => {
  it('加载态字段 batchInProgress? 缺省形态在位（D10：概念入 M0 契约，不随过渡期实现退场）', () => {
    const bare: DataSourcePayloadFields = {}
    const loading: DataSourcePayloadFields = { batchInProgress: true }
    expect(bare.batchInProgress).toBeUndefined()
    expect(loading.batchInProgress).toBe(true)
  })

  it('修订号字段不落（归重写侧同窗口对齐，只引用不实现——见 data-source-registry.ts 头注）', () => {
    const fields = { batchInProgress: false } satisfies DataSourcePayloadFields
    expect(Object.keys(fields)).toEqual(['batchInProgress'])
    // revision/generation 不在本形状：其类型落点 = 重写侧 u-m0 的
    // packages/shared/src/execution 契约（另一分支，本波不 import）。
    expect('revision' in fields).toBe(false)
    expect('generation' in fields).toBe(false)
  })
})
