/**
 * probe-opendesign-catalog 单测（纯函数部分：探测结论 → 档位 map / 快照差异补丁）。
 *
 * 不覆盖真网络（探测本体是 CI/手动工具，真机验证走 workflow 手跑）。这里只锁：
 * 档位 map 的三态语义（accepted→identity / rejected·unstable·未探测→null）、
 * input 只留 text/image、差异补丁只带差异字段、下线模型进 removeModels。
 */
import { describe, it, expect } from 'vitest'

// 相对路径从本文件（packages/runtime/src/services/remote-config/__tests__/）回到仓库根 = 6 级。
// 类型由同目录 scripts/probe-opendesign-catalog.d.mts 提供（脚本是无构建步骤的 ESM 手动工具，
// 手写 d.mts 让单测在类型检查下 import 而不必挂豁免标记）。
import {
  ALL_LEVELS,
  COMPAT,
  buildThinkingLevelMap,
  toPiInput,
  diffAgainstSnapshot,
} from '../../../../../../scripts/probe-opendesign-catalog.mjs'

type Verdict = 'accepted' | 'rejected' | 'unstable'

function verdicts(over: Record<string, Verdict> = {}): Map<string, Verdict> {
  const m = new Map<string, Verdict>()
  for (const l of ALL_LEVELS as string[]) m.set(l, over[l] ?? 'rejected')
  return m
}

describe('buildThinkingLevelMap', () => {
  it('全档接受 → identity 映射（档位名即 reasoning_effort 值）', () => {
    const all = verdicts(Object.fromEntries((ALL_LEVELS as string[]).map((l) => [l, 'accepted' as Verdict])))
    expect(buildThinkingLevelMap(all)).toEqual({
      off: 'off',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    })
  })

  it('被拒 / 不确定 / 未探测的档一律 null（不给会 400 的档）', () => {
    const map = buildThinkingLevelMap(verdicts({ off: 'accepted', high: 'accepted', medium: 'unstable' }))
    expect(map.off).toBe('off')
    expect(map.high).toBe('high')
    expect(map.medium).toBeNull()
    expect(map.minimal).toBeNull()
    expect(map.max).toBeNull()
  })

  it('全 7 档恒出现在 map 里（pi 的 xhigh/max 未显式列出 = 视为不支持，明确的 null 才无歧义）', () => {
    const map = buildThinkingLevelMap(verdicts())
    expect(Object.keys(map).sort()).toEqual([...ALL_LEVELS].sort())
  })
})

describe('toPiInput', () => {
  it('只留 text/image：file/audio/video 丢弃（pi ModelDefinitionSchema 枚举仅此二者）', () => {
    expect(toPiInput({ input_modalities: ['text', 'image', 'file', 'audio', 'video'] })).toEqual(['text', 'image'])
  })

  it('无 image → 仅 text；缺 architecture → 仅 text', () => {
    expect(toPiInput({ input_modalities: ['text'] })).toEqual(['text'])
    expect(toPiInput(undefined)).toEqual(['text'])
  })
})

describe('diffAgainstSnapshot', () => {
  const FIELDS_ALL = { id: 'm1', contextWindow: 1000, maxTokens: 100, reasoning: true, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, thinkingLevelMap: { off: 'off', high: 'high' }, compat: COMPAT }
  const draft = (models: Array<Record<string, unknown>>) =>
    ({ version: 1 as const, providers: [{ id: 'opendesign', models }] })

  it('与快照完全一致 → 空补丁（远程退化为零覆盖，发版后不回退）', () => {
    const snapshot = new Map([['m1', { ...FIELDS_ALL }]])
    const out = diffAgainstSnapshot(draft([{ ...FIELDS_ALL }]), snapshot)
    expect(out.providers[0].models).toEqual([])
    expect(out.providers[0].removeModels).toBeUndefined()
  })

  it('只带差异字段（id + 变化的那些），不复制未变字段', () => {
    const snapshot = new Map([['m1', { ...FIELDS_ALL }]])
    const out = diffAgainstSnapshot(draft([{ ...FIELDS_ALL, maxTokens: 999 }]), snapshot)
    expect(out.providers[0].models).toEqual([{ id: 'm1', maxTokens: 999 }])
  })

  it('快照没有的模型 → 整条新增（追加语义）', () => {
    const snapshot = new Map<string, Record<string, unknown>>()
    const out = diffAgainstSnapshot(draft([{ ...FIELDS_ALL }]), snapshot)
    expect(out.providers[0].models).toEqual([FIELDS_ALL])
  })

  it('快照有、目录下线 → 进 removeModels', () => {
    const snapshot = new Map([['gone', { ...FIELDS_ALL, id: 'gone' }]])
    const out = diffAgainstSnapshot(draft([]), snapshot)
    expect(out.providers[0].removeModels).toEqual(['gone'])
  })

  it('reasoning 由 true 变 false → 补丁显式带 false（不能靠省略表达）', () => {
    const snapshot = new Map([['m1', { ...FIELDS_ALL }]])
    const out = diffAgainstSnapshot(draft([{ ...FIELDS_ALL, reasoning: false, thinkingLevelMap: undefined, compat: undefined }]), snapshot)
    const patch = out.providers[0].models[0]
    expect(patch.reasoning).toBe(false)
  })

  it('快照不可读 → 退化为全量输出（并 warn）', () => {
    const out = diffAgainstSnapshot(draft([{ ...FIELDS_ALL }]), undefined)
    expect(out.providers[0].models).toEqual([FIELDS_ALL])
  })
})
