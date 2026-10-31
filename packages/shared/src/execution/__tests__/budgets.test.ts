/**
 * M0-4 契约测试：预算常量 shared 单源 + 环境变量覆盖 + 关系不变量。
 *
 * 权威：契约级终态裁决第 3 项（日志分段 8–16MB + 两级预算）与第 10 项（D17：预算
 * 常量进 shared 配置契约单源、可被环境变量覆盖、不允许散落字面量）。
 */

import { describe, expect, it } from 'vitest'

import {
  EXECUTION_BUDGET_DEFAULTS,
  EXECUTION_BUDGET_ENV_NAMES,
  resolveExecutionBudgets,
} from '../budgets'

describe('默认值单源', () => {
  it('默认值满足设计区间与两级预算关系不变量', () => {
    expect(EXECUTION_BUDGET_DEFAULTS.logSegmentMinBytes).toBe(8 * 1024 * 1024)
    expect(EXECUTION_BUDGET_DEFAULTS.logSegmentTargetBytes).toBe(16 * 1024 * 1024)
    expect(EXECUTION_BUDGET_DEFAULTS.logSegmentMinBytes).toBeLessThan(EXECUTION_BUDGET_DEFAULTS.logSegmentTargetBytes)
    expect(EXECUTION_BUDGET_DEFAULTS.sessionSoftLimitBytes).toBeLessThan(EXECUTION_BUDGET_DEFAULTS.sessionHardLimitBytes)
    expect(EXECUTION_BUDGET_DEFAULTS.globalSoftLimitBytes).toBeLessThan(EXECUTION_BUDGET_DEFAULTS.globalHardLimitBytes)
    expect(EXECUTION_BUDGET_DEFAULTS.sessionHardLimitBytes).toBeLessThanOrEqual(
      EXECUTION_BUDGET_DEFAULTS.globalHardLimitBytes,
    )
    expect(EXECUTION_BUDGET_DEFAULTS.sessionSoftLimitBytes).toBeLessThanOrEqual(
      EXECUTION_BUDGET_DEFAULTS.globalSoftLimitBytes,
    )
    expect(EXECUTION_BUDGET_DEFAULTS.contactLostGraceMs).toBeGreaterThan(0)
  })

  it('默认值对象被冻结（运行时不可改写）', () => {
    expect(Object.isFrozen(EXECUTION_BUDGET_DEFAULTS)).toBe(true)
  })

  it('环境变量名覆盖全部预算字段且彼此唯一', () => {
    expect(Object.keys(EXECUTION_BUDGET_ENV_NAMES).sort()).toEqual(Object.keys(EXECUTION_BUDGET_DEFAULTS).sort())
    const names = Object.values(EXECUTION_BUDGET_ENV_NAMES)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name.startsWith('TAIJI_')).toBe(true)
  })
})

describe('环境变量覆盖', () => {
  it('缺省 env = 全部走默认值', () => {
    const result = resolveExecutionBudgets({})
    expect(result.budgets).toEqual(EXECUTION_BUDGET_DEFAULTS)
    expect(result.ignored).toEqual([])
  })

  it('逐字段覆盖生效', () => {
    const result = resolveExecutionBudgets({
      [EXECUTION_BUDGET_ENV_NAMES.logSegmentMinBytes]: String(4 * 1024 * 1024),
      [EXECUTION_BUDGET_ENV_NAMES.logSegmentTargetBytes]: String(8 * 1024 * 1024),
      [EXECUTION_BUDGET_ENV_NAMES.sessionSoftLimitBytes]: String(64 * 1024 * 1024),
      [EXECUTION_BUDGET_ENV_NAMES.sessionHardLimitBytes]: String(128 * 1024 * 1024),
      [EXECUTION_BUDGET_ENV_NAMES.globalSoftLimitBytes]: String(1024 * 1024 * 1024),
      [EXECUTION_BUDGET_ENV_NAMES.globalHardLimitBytes]: String(2 * 1024 * 1024 * 1024),
      [EXECUTION_BUDGET_ENV_NAMES.contactLostGraceMs]: '5000',
    })
    expect(result.ignored).toEqual([])
    expect(result.budgets).toEqual({
      logSegmentMinBytes: 4 * 1024 * 1024,
      logSegmentTargetBytes: 8 * 1024 * 1024,
      sessionSoftLimitBytes: 64 * 1024 * 1024,
      sessionHardLimitBytes: 128 * 1024 * 1024,
      globalSoftLimitBytes: 1024 * 1024 * 1024,
      globalHardLimitBytes: 2 * 1024 * 1024 * 1024,
      contactLostGraceMs: 5000,
    })
  })

  it('非法值回退默认并记录 ignored（不静默吞）', () => {
    const envName = EXECUTION_BUDGET_ENV_NAMES.contactLostGraceMs
    const result = resolveExecutionBudgets({ [envName]: 'not-a-number' })
    expect(result.budgets.contactLostGraceMs).toBe(EXECUTION_BUDGET_DEFAULTS.contactLostGraceMs)
    expect(result.ignored).toHaveLength(1)
    expect(result.ignored[0]).toMatchObject({ envName, rawValue: 'not-a-number' })
    expect(result.ignored[0]?.reason).toContain('恢复动作')
  })

  it('零 / 负数 / 小数均判非法', () => {
    for (const raw of ['0', '-1', '1.5']) {
      const result = resolveExecutionBudgets({ [EXECUTION_BUDGET_ENV_NAMES.contactLostGraceMs]: raw })
      expect(result.ignored).toHaveLength(1)
      expect(result.budgets.contactLostGraceMs).toBe(EXECUTION_BUDGET_DEFAULTS.contactLostGraceMs)
    }
  })
})

describe('关系不变量（覆盖破坏时回退默认值）', () => {
  it('段 min > target → 两个段覆盖都回退', () => {
    const result = resolveExecutionBudgets({
      [EXECUTION_BUDGET_ENV_NAMES.logSegmentMinBytes]: String(32 * 1024 * 1024),
      [EXECUTION_BUDGET_ENV_NAMES.logSegmentTargetBytes]: String(16 * 1024 * 1024),
    })
    expect(result.budgets.logSegmentMinBytes).toBe(EXECUTION_BUDGET_DEFAULTS.logSegmentMinBytes)
    expect(result.budgets.logSegmentTargetBytes).toBe(EXECUTION_BUDGET_DEFAULTS.logSegmentTargetBytes)
    expect(result.ignored.length).toBeGreaterThan(0)
  })

  it('会话 soft ≥ hard → 两个会话覆盖都回退', () => {
    const result = resolveExecutionBudgets({
      [EXECUTION_BUDGET_ENV_NAMES.sessionSoftLimitBytes]: String(256 * 1024 * 1024),
      [EXECUTION_BUDGET_ENV_NAMES.sessionHardLimitBytes]: String(256 * 1024 * 1024),
    })
    expect(result.budgets.sessionSoftLimitBytes).toBe(EXECUTION_BUDGET_DEFAULTS.sessionSoftLimitBytes)
    expect(result.budgets.sessionHardLimitBytes).toBe(EXECUTION_BUDGET_DEFAULTS.sessionHardLimitBytes)
  })

  it('会话硬限 > 全局硬限 → 冲突侧的硬限覆盖回退', () => {
    const result = resolveExecutionBudgets({
      [EXECUTION_BUDGET_ENV_NAMES.sessionHardLimitBytes]: String(8 * 1024 * 1024 * 1024),
    })
    expect(result.budgets.sessionHardLimitBytes).toBe(EXECUTION_BUDGET_DEFAULTS.sessionHardLimitBytes)
  })

  it('全局 soft ≥ hard → 两个全局覆盖都回退', () => {
    const result = resolveExecutionBudgets({
      [EXECUTION_BUDGET_ENV_NAMES.globalSoftLimitBytes]: String(4 * 1024 * 1024 * 1024),
      [EXECUTION_BUDGET_ENV_NAMES.globalHardLimitBytes]: String(4 * 1024 * 1024 * 1024),
    })
    expect(result.budgets.globalSoftLimitBytes).toBe(EXECUTION_BUDGET_DEFAULTS.globalSoftLimitBytes)
    expect(result.budgets.globalHardLimitBytes).toBe(EXECUTION_BUDGET_DEFAULTS.globalHardLimitBytes)
  })

  it('组合覆盖链式回退后仍满足全部不变量且逐项记录 ignored（校验收敛至不动点）', () => {
    // 会话软限 600MB + 会话硬限 8GB 同时覆盖：第一遍软<硬通过、会话硬限>全局硬限
    // （8GB > 4GB 默认）触发会话硬限回退默认 512MB；回退后软限 600MB ≥ 硬限 512MB
    // 必须被复检捕获、软限也回退默认——不得以「软限 ≥ 硬限」的矛盾组合静默生效。
    const result = resolveExecutionBudgets({
      [EXECUTION_BUDGET_ENV_NAMES.sessionSoftLimitBytes]: String(629145600),
      [EXECUTION_BUDGET_ENV_NAMES.sessionHardLimitBytes]: String(8589934592),
    })
    expect(result.budgets.logSegmentMinBytes).toBeLessThanOrEqual(result.budgets.logSegmentTargetBytes)
    expect(result.budgets.sessionSoftLimitBytes).toBeLessThan(result.budgets.sessionHardLimitBytes)
    expect(result.budgets.globalSoftLimitBytes).toBeLessThan(result.budgets.globalHardLimitBytes)
    expect(result.budgets.sessionHardLimitBytes).toBeLessThanOrEqual(result.budgets.globalHardLimitBytes)
    expect(result.budgets.sessionSoftLimitBytes).toBeLessThanOrEqual(result.budgets.globalSoftLimitBytes)
    expect(result.budgets.sessionSoftLimitBytes).toBe(EXECUTION_BUDGET_DEFAULTS.sessionSoftLimitBytes)
    expect(result.budgets.sessionHardLimitBytes).toBe(EXECUTION_BUDGET_DEFAULTS.sessionHardLimitBytes)
    // fail-visible：两个被覆盖字段各有一条带原始值与恢复动作的拒绝记录，不静默回退。
    expect(result.ignored).toHaveLength(2)
    const ignoredByEnvName = new Map(result.ignored.map((issue) => [issue.envName, issue]))
    const softIssue = ignoredByEnvName.get(EXECUTION_BUDGET_ENV_NAMES.sessionSoftLimitBytes)
    const hardIssue = ignoredByEnvName.get(EXECUTION_BUDGET_ENV_NAMES.sessionHardLimitBytes)
    expect(softIssue?.rawValue).toBe('629145600')
    expect(softIssue?.reason).toContain('恢复动作')
    expect(hardIssue?.rawValue).toBe('8589934592')
    expect(hardIssue?.reason).toContain('恢复动作')
  })
})
