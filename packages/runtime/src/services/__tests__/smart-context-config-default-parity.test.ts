/**
 * smart-context runtime 落盘默认基底 ↔ extension DEFAULT_SMART_CONTEXT_CONFIG 对拍
 * （dmg-r2-3）。
 *
 * 背景：autoCompactThresholdRatio 字段加进 extension 侧 DEFAULT 时 runtime 配置层没跟上，
 * 而文件头注声称基底「与 extension DEFAULT 一致」——声称失真、且两侧无机器对拍，下次加
 * 字段还会单侧漂移。本测试把该一致性变成机器断言。
 *
 * 对拍口径（import extension 侧 pure.ts 源码叶子，逐字段深相等，非手抄常量）：
 * - RMW 在配置文件缺失 / 坏 JSON 时以 runtime 默认基底重建文件，写出的内容必须与
 *   extension DEFAULT_SMART_CONTEXT_CONFIG 全字段一致（本次写入的字段除外）；
 * - extension 的 normalize 读 runtime 写出的文件必须还原同一份默认配置——即 runtime
 *   种子文件对 extension 读取侧是完整的，不依赖 extension 补默认。
 *
 * 为什么经相对路径 import 扩展侧源码：runtime 包不声明对 smart-context extension 的
 * workspace 依赖（pure.ts 是零副作用纯函数叶子），仅为测试 import 而加依赖声明属
 * phantom dep（声明了却不被生产代码使用的依赖）；跨包源码消费有先例——
 * packages/subagent-core/src/execution/engine/__tests__/conformance/
 * registry-fork-filter.test.ts 同款形态。
 *
 * 运行：pnpm -C packages/runtime test -- src/services/__tests__/smart-context-config-default-parity.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SMART_CONTEXT_CONFIG,
  normalizeSmartContextConfig,
} from '../../../../../extensions/universal/smart-context/src/pure.ts'
import { setSmartContextEnabled } from '../smart-context-config.js'

/** 配置文件名（与 smart-context-config.ts 的 SMART_CONTEXT_CONFIG_REL 契约一致）。 */
const CONFIG_REL = join('config', 'smart-context-ext-config.json')

let tmpRoot = ''

beforeEach(() => {
  // 每例独立临时目录；getPiAgentDir 经 getDataDir 读 TAIJI_AGENT_DATA_DIR → <tmp>/agent
  tmpRoot = mkdtempSync(join(tmpdir(), 'smart-context-parity-'))
  vi.stubEnv('TAIJI_AGENT_DATA_DIR', tmpRoot)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 读回 runtime 写出的配置对象（无文件 → undefined）。 */
function readWrittenConfig(): Record<string, unknown> | undefined {
  const p = join(tmpRoot, 'agent', CONFIG_REL)
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

describe('smart-context 落盘默认基底 ↔ extension DEFAULT_SMART_CONTEXT_CONFIG 对拍', () => {
  it('文件缺失时 RMW 写出的基底与 extension DEFAULT 全字段一致（含 autoCompactThresholdRatio）', () => {
    setSmartContextEnabled(false)

    // 深相等而非逐字段：extension DEFAULT 将来加字段而基底没跟上时本断言红灯
    expect(readWrittenConfig()).toEqual({ ...DEFAULT_SMART_CONTEXT_CONFIG, enabled: false })
  })

  it('坏 JSON 时同样以完整基底重建（不只补本次写入字段）', () => {
    const p = join(tmpRoot, 'agent', CONFIG_REL)
    mkdirSync(join(tmpRoot, 'agent', 'config'), { recursive: true })
    writeFileSync(p, '{ corrupted', 'utf-8')

    setSmartContextEnabled(true)

    expect(readWrittenConfig()).toEqual(DEFAULT_SMART_CONTEXT_CONFIG)
  })

  it('extension normalize 读 runtime 写出的文件还原同一份默认配置（种子文件对读取侧完整）', () => {
    // 注意：本断言在基底缺 ratio 时也绿（extension normalize 对缺失字段补自己的默认）——
    // 那正是本轮漂移长期无声的原因。真正的漂移守卫是上两条「写出内容深相等」。
    setSmartContextEnabled(false)

    expect(normalizeSmartContextConfig(readWrittenConfig())).toEqual({
      ...DEFAULT_SMART_CONTEXT_CONFIG,
      enabled: false,
    })
  })
})
