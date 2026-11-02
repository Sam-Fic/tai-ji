/**
 * background-idle-config.test.ts — idleBackgroundSec 跨层契约校验（真值表）
 *
 * 本文件是共享归一化实现的语义钉子：扩展配置侧（base-tool-enhance config.ts 经
 * anomaly→warn 包装消费）与 runtime 静默判定矩阵 T 公式（直取 value）共用同一实现，
 * 任何一侧语义变化都必须先改本实现并过本真值表——禁止任何一侧回退为本地镜像副本
 * （历史事故：两侧手抄归一化无机器绑定，超大值 clamp 语义漂移）。
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_IDLE_BACKGROUND_SEC, normalizeIdleBackgroundSec } from './background-idle-config'

describe('idleBackgroundSec 跨层归一化（真值表）', () => {
  it('默认值锁定 600（两侧 T 公式与配置缺省共享此值）', () => {
    expect(DEFAULT_IDLE_BACKGROUND_SEC).toBe(600)
  })

  it('undefined（未配置）→ 默认 600，非异常（配置缺省不 warn 的判据）', () => {
    expect(normalizeIdleBackgroundSec(undefined)).toEqual({ value: 600, anomaly: null })
  })

  it('null（显式关闭）→ null 透传（显式 null 是唯一关闭通道）', () => {
    expect(normalizeIdleBackgroundSec(null)).toEqual({ value: null, anomaly: null })
  })

  it('正整数透传', () => {
    expect(normalizeIdleBackgroundSec(30)).toEqual({ value: 30, anomaly: null })
    expect(normalizeIdleBackgroundSec(600)).toEqual({ value: 600, anomaly: null })
    expect(normalizeIdleBackgroundSec(2_147_483)).toEqual({ value: 2_147_483, anomaly: null })
  })

  it('小数 floor（<1 抬到 1：--idle 0 语义是首轮监控即转后台，不是亚秒阈值近似）', () => {
    expect(normalizeIdleBackgroundSec(1.5)).toEqual({ value: 1, anomaly: null })
    expect(normalizeIdleBackgroundSec(0.5)).toEqual({ value: 1, anomaly: null })
    expect(normalizeIdleBackgroundSec(90.9)).toEqual({ value: 90, anomaly: null })
  })

  it('换算毫秒超 int32 上限 → clamp 至 floor(int32 ms 对应秒数) + clamped 异常形态', () => {
    expect(normalizeIdleBackgroundSec(1_000_000_000)).toEqual({ value: 2_147_483, anomaly: 'clamped' })
    // 上限边界内（2147483.5s = 2147483500ms ≤ int32 max）不 clamp
    expect(normalizeIdleBackgroundSec(2_147_483.5)).toEqual({ value: 2_147_483, anomaly: null })
    // 超界小数同样收敛为整数（2147483.9s → floor(int32)）
    expect(normalizeIdleBackgroundSec(2_147_483.9)).toEqual({ value: 2_147_483, anomaly: 'clamped' })
  })

  it('坏值（0/负数/字符串/NaN/Infinity/类型错）→ 回退默认 600 + invalid 异常形态（坏值不得意外关闭机制）', () => {
    for (const bad of [0, -5, '10', Number.NaN, Number.POSITIVE_INFINITY, true, ['x'], { sec: 1 }]) {
      expect(normalizeIdleBackgroundSec(bad)).toEqual({ value: 600, anomaly: 'invalid' })
    }
  })
})
