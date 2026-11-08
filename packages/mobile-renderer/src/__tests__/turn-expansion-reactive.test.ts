/**
 * turn 展开分区响应式单测（chat-turn-fold-redesign 验收 P1 断链回归）。
 *
 * 背景：app-runtime 的 turnExpansionMap 曾是 plain Map + plain Set——Turn.vue 的
 * turnExpanded computed（deps.isExpanded 读 has）在 mobile 上 toggle 后永不失效
 * （点 chevron 后 trace 区不展开、收纳明细行不出、chevron 旋转指示不动）。修复 =
 * 外层 plain Map + 内层 reactive Set（对齐桌面 turn-expansion store 双层形态），
 * 惰性创建分区保证 effect 首跑即在内层建立依赖。
 *
 * 本文件锁 createTurnExpansion 的响应式语义（effect 内读 isExpanded → toggle →
 * effect 重跑）；Turn 渲染链（trace 区形态）由 ui 包 Turn.test.ts 三态矩阵承载。
 */
import { computed, ref, watchEffect } from 'vue'
import { describe, it, expect } from 'vitest'
import { createTurnExpansion } from '../shell/app-runtime'
import { triggerSessionCleanups } from '@taiji/core/foundation/use-session-scoped-state'

// 独立 sid 前缀：turnExpansionMap 是 app-runtime 模块级状态，跨文件共享——
// 避免与其它测试文件的分区撞 key（清理用例显式 triggerSessionCleanups）
const SID_PREFIX = 's-turnexp-reactive'

describe('turn 展开分区响应式（createTurnExpansion）', () => {
  it('effect 内读 isExpanded → toggle → effect 重跑（reactive Set 建立依赖，断链回归）', () => {
    const deps = createTurnExpansion(ref(`${SID_PREFIX}-effect`))
    const values: boolean[] = []
    // flush: sync——toggle 后立即重跑（默认 pre 是异步批处理，断言点取不到新值）
    const stop = watchEffect(() => { values.push(deps.isExpanded('tk1')) }, { flush: 'sync' })
    // 首跑：false（分区惰性创建，依赖建立在 reactive Set 的 has 上）
    expect(values).toEqual([false])
    deps.toggle('tk1')
    // 修复前断链形态：plain Set 的 add 不触发任何通知，values 停留 [false]
    expect(values).toEqual([false, true])
    deps.toggle('tk1')
    expect(values).toEqual([false, true, false])
    stop()
  })

  it('computed 感知（Turn.vue turnExpanded 同链路）：toggle 后取值翻转', () => {
    const deps = createTurnExpansion(ref(`${SID_PREFIX}-computed`))
    const turnExpanded = computed(() => deps.isExpanded('u1'))
    expect(turnExpanded.value).toBe(false)
    deps.toggle('u1')
    expect(turnExpanded.value).toBe(true)
    deps.toggle('u1')
    expect(turnExpanded.value).toBe(false)
  })

  it('分区隔离：不同 session 的展开态互不影响；未展开 key 恒 false', () => {
    const a = createTurnExpansion(ref(`${SID_PREFIX}-iso-a`))
    const b = createTurnExpansion(ref(`${SID_PREFIX}-iso-b`))
    a.toggle('u1')
    expect(a.isExpanded('u1')).toBe(true)
    expect(b.isExpanded('u1')).toBe(false)
    expect(a.isExpanded('unknown-key')).toBe(false)
  })

  it('session 清理：triggerSessionCleanups 后分区清空（clear 通知 + delete，重读 = false）', () => {
    const sid = `${SID_PREFIX}-cleanup`
    const deps = createTurnExpansion(ref(sid))
    deps.toggle('u1')
    expect(deps.isExpanded('u1')).toBe(true)
    // app-runtime 模块级 registerSessionCleanup 注册的清理随 registry 遍历触发
    triggerSessionCleanups(sid)
    expect(deps.isExpanded('u1')).toBe(false)
  })
})
