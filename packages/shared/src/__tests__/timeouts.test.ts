/**
 * shared timeouts 单测（timeout-slow-flow-wallclock D2，u-y2；D3，u-y3）。
 *
 * 守护：BASH_RPC_TIMEOUT_MS 值与语义（1h 回收层有界兜底档，非任务正常路径超时）；
 * RENDERER_RPC_MARGIN_MS 值与校准链关系（renderer = runtime 第一刀 + margin）。
 * [C2 /compact 后台化] COMPACT_RPC_TIMEOUT_MS（30min 压缩墙钟）随同步 compact 链退役
 * ——受理型 compactBackground RPC 超时归 RPC_BACKSTOP_TIMEOUT_MS 普通档，压缩全程不再
 * 占请求窗口。
 */
import { describe, it, expect } from 'vitest'
import { BASH_RPC_TIMEOUT_MS, RENDERER_RPC_MARGIN_MS } from '../timeouts.js'

describe('BASH_RPC_TIMEOUT_MS（D2 composer bash RPC 独立常量）', () => {
  it('值 = 3_600_000（1 小时，对齐 worktree TIMEOUT_MAX=3600 先例）', () => {
    expect(BASH_RPC_TIMEOUT_MS).toBe(3_600_000)
  })

  it('量级为小时级（≥ 30min），回收层有界兜底档', () => {
    // D2 的取值论证：bash 是任务级慢速流（合法耗时可达小时级），1h 是回收层有界兜底档。
    // 若未来调小到分钟级（<30min）即回到「!sleep 320 被误杀」的前科形态，必须重新过设计。
    expect(BASH_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(1_800_000)
  })
})

describe('RENDERER_RPC_MARGIN_MS（D3 校准链余量）', () => {
  it('值：RENDERER_RPC_MARGIN_MS = 60_000（60s）', () => {
    expect(RENDERER_RPC_MARGIN_MS).toBe(60_000)
  })

  it('余量为正：bash backstop = BASH + MARGIN > BASH（runtime 第一刀恒先收尾）', () => {
    // D3 不变量：renderer 恒不先于 runtime 判死。renderer 超时取
    // BASH_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS 表达式（chat.ts 编译期同源），
    // 本断言守护「余量为正」这一前提——MARGIN ≤ 0 时表达式退化为零余量竞态前科形态。
    expect(BASH_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS).toBeGreaterThan(BASH_RPC_TIMEOUT_MS)
  })
})
