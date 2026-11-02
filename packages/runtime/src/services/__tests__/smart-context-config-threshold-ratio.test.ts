/**
 * autoCompactThresholdRatio 契约链单测（C3 独立压缩设置页）：setter clamp 语义与
 * extension normalizeSmartContextConfig 同款（非有限数回默认 0.9，有限数钳制 [0,1]），
 * RMW 只覆盖该字段、保留其余字段。
 *
 * 运行：pnpm -C packages/runtime test -- src/services/__tests__/smart-context-config-threshold-ratio.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getSmartContextConfig, setSmartContextAutoCompactThresholdRatio } from '../smart-context-config.js'

/** 配置文件名（与 smart-context-config.ts 的 SMART_CONTEXT_CONFIG_REL 契约一致）。 */
const CONFIG_REL = join('config', 'smart-context-ext-config.json')

let tmpRoot = ''

beforeEach(() => {
  // 每例独立临时目录；getPiAgentDir 经 getDataDir 读 TAIJI_AGENT_DATA_DIR → <tmp>/agent
  tmpRoot = mkdtempSync(join(tmpdir(), 'smart-context-ratio-'))
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', tmpRoot)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 预置一份全字段配置文件（模拟用户既有配置，RMW 后其余字段必须原样保留）。 */
function seedConfigFile(ratio: unknown): void {
  mkdirSync(join(tmpRoot, 'agent', 'config'), { recursive: true })
  writeFileSync(
    join(tmpRoot, 'agent', CONFIG_REL),
    JSON.stringify(
      {
        enabled: false,
        compactModel: { type: 'ref', ref: 'p1/m1' },
        reminderThresholds: [100_000, 200_000, 300_000],
        excludedModels: ['p9/m9'],
        autoCompactThresholdRatio: ratio,
      },
      null,
      2,
    ),
    'utf-8',
  )
}

describe('setSmartContextAutoCompactThresholdRatio clamp（C3）', () => {
  it('合法值原样落盘 + 快照读回一致 + 其余字段保留', () => {
    seedConfigFile(0.9)
    setSmartContextAutoCompactThresholdRatio(0.85)

    const cfg = getSmartContextConfig()
    expect(cfg.autoCompactThresholdRatio).toBe(0.85)
    expect(cfg.enabled).toBe(false)
    expect(cfg.compactModel).toBe('p1/m1')
    expect(cfg.reminderThresholds).toEqual([100_000, 200_000, 300_000])
    expect(cfg.excludedModels).toEqual(['p9/m9'])
  })

  it('越界值钳制到 [0,1]：1.5 → 1、-0.2 → 0、边界 0 与 1 原样', () => {
    seedConfigFile(0.9)
    setSmartContextAutoCompactThresholdRatio(1.5)
    expect(getSmartContextConfig().autoCompactThresholdRatio).toBe(1)

    seedConfigFile(0.9)
    setSmartContextAutoCompactThresholdRatio(-0.2)
    expect(getSmartContextConfig().autoCompactThresholdRatio).toBe(0)

    seedConfigFile(0.9)
    setSmartContextAutoCompactThresholdRatio(0)
    expect(getSmartContextConfig().autoCompactThresholdRatio).toBe(0)

    seedConfigFile(0.9)
    setSmartContextAutoCompactThresholdRatio(1)
    expect(getSmartContextConfig().autoCompactThresholdRatio).toBe(1)
  })

  it('非有限数归默认 0.9（与 extension normalize 同款回退）', () => {
    seedConfigFile(0.9)
    setSmartContextAutoCompactThresholdRatio(Number.NaN)
    expect(getSmartContextConfig().autoCompactThresholdRatio).toBe(0.9)

    seedConfigFile(0.9)
    setSmartContextAutoCompactThresholdRatio(Number.POSITIVE_INFINITY)
    expect(getSmartContextConfig().autoCompactThresholdRatio).toBe(0.9)
  })

  it('快照读取回退：文件缺字段 / 字段非法 → 默认 0.9（不依赖 extension 补默认）', () => {
    seedConfigFile('not-a-number')
    expect(getSmartContextConfig().autoCompactThresholdRatio).toBe(0.9)

    // 缺字段形态：重写一份不含 ratio 键的配置
    mkdirSync(join(tmpRoot, 'agent', 'config'), { recursive: true })
    writeFileSync(
      join(tmpRoot, 'agent', CONFIG_REL),
      JSON.stringify(
        { enabled: true, compactModel: { type: 'ref', ref: '' }, reminderThresholds: [400_000, 500_000, 600_000], excludedModels: [] },
        null,
        2,
      ),
      'utf-8',
    )
    expect(getSmartContextConfig().autoCompactThresholdRatio).toBe(0.9)
  })
})
